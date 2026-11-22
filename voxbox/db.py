"""SQLite persistence for VoxBox: dictations, dictionary, snippets, transforms, scratchpad & insights."""

from __future__ import annotations

import datetime as dt
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .config import DATA_DIR

DEFAULT_TRANSFORMS = [
    (
        "Polish",
        "Improve clarity, grammar, and conciseness while keeping your tone.",
        "Rewrite the text to be clear, concise, and well-structured while keeping the exact meaning and tone. Output ONLY the rewritten text.",
    ),
    (
        "Prompt Engineer",
        "Turn rough spoken ideas into a crisp, structured AI prompt.",
        "Convert the dictated thoughts into a clear, well-structured prompt for an AI coding/reasoning assistant with explicit goals, constraints, and bullet points. Output ONLY the prompt.",
    ),
    (
        "Bullet Summary",
        "Distill spoken thoughts into clean, actionable bullet points.",
        "Convert the text into crisp, scannable bullet points with no fluff. Output ONLY the bullet points.",
    ),
]


class VoxBoxDB:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (DATA_DIR / "voxbox.db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS dictations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at REAL NOT NULL,
                    raw_text TEXT NOT NULL,
                    cleaned_text TEXT NOT NULL,
                    word_count INTEGER NOT NULL DEFAULT 0,
                    duration_sec REAL NOT NULL DEFAULT 0,
                    stt_ms INTEGER NOT NULL DEFAULT 0,
                    llm_ms INTEGER NOT NULL DEFAULT 0,
                    fixes_count INTEGER NOT NULL DEFAULT 0,
                    dict_fixes INTEGER NOT NULL DEFAULT 0,
                    style TEXT NOT NULL DEFAULT 'default',
                    transform_name TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS dictionary (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    replacement TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS snippets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trigger TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    expansion TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS transforms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT NOT NULL DEFAULT '',
                    prompt TEXT NOT NULL,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS scratchpad (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    pinned INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )
            count = self._conn.execute("SELECT COUNT(*) FROM transforms").fetchone()[0]
            if count == 0:
                now = time.time()
                for name, desc, prompt in DEFAULT_TRANSFORMS:
                    self._conn.execute(
                        "INSERT INTO transforms (name, description, prompt, is_default, created_at) VALUES (?, ?, ?, 1, ?)",
                        (name, desc, prompt, now),
                    )

    # ---------- Dictations ----------

    def add_dictation(
        self,
        *,
        raw_text: str,
        cleaned_text: str,
        duration_sec: float,
        stt_ms: int,
        llm_ms: int,
        fixes_count: int = 0,
        dict_fixes: int = 0,
        style: str = "default",
        transform_name: str = "",
    ) -> dict[str, Any]:
        words = len(cleaned_text.split())
        now = time.time()
        with self._lock, self._conn:
            cur = self._conn.execute(
                """
                INSERT INTO dictations
                (created_at, raw_text, cleaned_text, word_count, duration_sec, stt_ms, llm_ms, fixes_count, dict_fixes, style, transform_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now,
                    raw_text,
                    cleaned_text,
                    words,
                    round(duration_sec, 2),
                    stt_ms,
                    llm_ms,
                    fixes_count,
                    dict_fixes,
                    style,
                    transform_name,
                ),
            )
            row = self._conn.execute("SELECT * FROM dictations WHERE id = ?", (cur.lastrowid,)).fetchone()
            return dict(row)

    def list_dictations(self, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            if query.strip():
                like = f"%{query.strip()}%"
                rows = self._conn.execute(
                    "SELECT * FROM dictations WHERE cleaned_text LIKE ? OR raw_text LIKE ? ORDER BY created_at DESC LIMIT ?",
                    (like, like, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM dictations ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]

    def delete_dictation(self, item_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM dictations WHERE id = ?", (item_id,))
            return cur.rowcount > 0

    def clear_dictations(self) -> None:
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM dictations")

    # ---------- Insights ----------

    def get_insights(self) -> dict[str, Any]:
        with self._lock:
            agg = self._conn.execute(
                """
                SELECT
                    COUNT(*) AS total_dictations,
                    COALESCE(SUM(word_count), 0) AS total_words,
                    COALESCE(SUM(duration_sec), 0) AS total_duration_sec,
                    COALESCE(SUM(fixes_count), 0) AS words_corrected,
                    COALESCE(SUM(dict_fixes), 0) AS dict_fixes,
                    COALESCE(AVG(stt_ms), 0) AS avg_stt_ms,
                    COALESCE(AVG(llm_ms), 0) AS avg_llm_ms
                FROM dictations
                """
            ).fetchone()

            rows = self._conn.execute("SELECT created_at, word_count FROM dictations ORDER BY created_at ASC").fetchall()

        total_words = int(agg["total_words"])
        total_dur = float(agg["total_duration_sec"])
        wpm = int(round((total_words / total_dur) * 60)) if total_dur >= 1.0 else 0

        # Group words per local calendar day (YYYY-MM-DD)
        day_counts: dict[str, int] = {}
        for r in rows:
            day = dt.datetime.fromtimestamp(r["created_at"]).strftime("%Y-%m-%d")
            day_counts[day] = day_counts.get(day, 0) + int(r["word_count"])

        # Compute current & longest streaks
        active_dates = sorted(dt.date.fromisoformat(d) for d in day_counts)
        longest_streak = 0
        run = 0
        prev: dt.date | None = None
        for d in active_dates:
            if prev is not None and (d - prev).days == 1:
                run += 1
            else:
                run = 1
            if run > longest_streak:
                longest_streak = run
            prev = d

        today = dt.date.today()
        current_streak = 0
        cursor = today
        if cursor.isoformat() not in day_counts and (today - dt.timedelta(days=1)).isoformat() in day_counts:
            cursor = today - dt.timedelta(days=1)
        while cursor.isoformat() in day_counts:
            current_streak += 1
            cursor -= dt.timedelta(days=1)

        # Build 16-week (112-day) heatmap grid ending today
        heatmap: list[dict[str, Any]] = []
        start_day = today - dt.timedelta(days=111)
        for i in range(112):
            d = start_day + dt.timedelta(days=i)
            iso = d.isoformat()
            heatmap.append({"date": iso, "words": day_counts.get(iso, 0)})

        return {
            "total_dictations": int(agg["total_dictations"]),
            "total_words": total_words,
            "wpm": wpm,
            "words_corrected": int(agg["words_corrected"]),
            "dict_fixes": int(agg["dict_fixes"]),
            "total_fixes": int(agg["words_corrected"]) + int(agg["dict_fixes"]),
            "avg_stt_ms": int(round(agg["avg_stt_ms"])),
            "avg_llm_ms": int(round(agg["avg_llm_ms"])),
            "current_streak": current_streak,
            "longest_streak": longest_streak,
            "heatmap": heatmap,
        }

    # ---------- Dictionary ----------

    def list_dictionary(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM dictionary ORDER BY created_at DESC").fetchall()
            return [dict(r) for r in rows]

    def add_dictionary_word(self, word: str, replacement: str = "") -> dict[str, Any]:
        word = word.strip()
        replacement = replacement.strip()
        if not word:
            raise ValueError("Word cannot be empty")
        now = time.time()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO dictionary (word, replacement, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(word) DO UPDATE SET replacement = excluded.replacement
                """,
                (word, replacement, now),
            )
            row = self._conn.execute("SELECT * FROM dictionary WHERE word = ? COLLATE NOCASE", (word,)).fetchone()
            return dict(row)

    def delete_dictionary_word(self, item_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM dictionary WHERE id = ?", (item_id,))
            return cur.rowcount > 0

    # ---------- Snippets ----------

    def list_snippets(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM snippets ORDER BY created_at DESC").fetchall()
            return [dict(r) for r in rows]

    def upsert_snippet(self, trigger: str, expansion: str) -> dict[str, Any]:
        trigger = trigger.strip()
        expansion = expansion.strip()
        if not trigger or not expansion:
            raise ValueError("Both trigger and expansion are required")
        now = time.time()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO snippets (trigger, expansion, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(trigger) DO UPDATE SET expansion = excluded.expansion
                """,
                (trigger, expansion, now),
            )
            row = self._conn.execute("SELECT * FROM snippets WHERE trigger = ? COLLATE NOCASE", (trigger,)).fetchone()
            return dict(row)

    def delete_snippet(self, item_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM snippets WHERE id = ?", (item_id,))
            return cur.rowcount > 0

    # ---------- Transforms ----------

    def list_transforms(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM transforms ORDER BY is_default DESC, id ASC").fetchall()
            return [dict(r) for r in rows]

    def get_transform(self, item_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM transforms WHERE id = ?", (item_id,)).fetchone()
            return dict(row) if row else None

    def upsert_transform(self, name: str, description: str, prompt: str, item_id: int | None = None) -> dict[str, Any]:
        name = name.strip()
        prompt = prompt.strip()
        if not name or not prompt:
            raise ValueError("Transform name and prompt are required")
        now = time.time()
        with self._lock, self._conn:
            if item_id is not None:
                self._conn.execute(
                    "UPDATE transforms SET name = ?, description = ?, prompt = ? WHERE id = ?",
                    (name, description.strip(), prompt, item_id),
                )
                row = self._conn.execute("SELECT * FROM transforms WHERE id = ?", (item_id,)).fetchone()
            else:
                cur = self._conn.execute(
                    "INSERT INTO transforms (name, description, prompt, is_default, created_at) VALUES (?, ?, ?, 0, ?)",
                    (name, description.strip(), prompt, now),
                )
                row = self._conn.execute("SELECT * FROM transforms WHERE id = ?", (cur.lastrowid,)).fetchone()
            return dict(row)

    def delete_transform(self, item_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM transforms WHERE id = ?", (item_id,))
            return cur.rowcount > 0

    def reset_default_transforms(self) -> list[dict[str, Any]]:
        now = time.time()
        with self._lock, self._conn:
            for name, desc, prompt in DEFAULT_TRANSFORMS:
                self._conn.execute(
                    """
                    INSERT INTO transforms (name, description, prompt, is_default, created_at)
                    VALUES (?, ?, ?, 1, ?)
                    ON CONFLICT(name) DO UPDATE SET description = excluded.description, prompt = excluded.prompt
                    """,
                    (name, desc, prompt, now),
                )
        return self.list_transforms()

    # ---------- Scratchpad ----------

    def list_notes(self, query: str = "") -> list[dict[str, Any]]:
        with self._lock:
            if query.strip():
                like = f"%{query.strip()}%"
                rows = self._conn.execute(
                    "SELECT * FROM scratchpad WHERE title LIKE ? OR content LIKE ? ORDER BY pinned DESC, updated_at DESC",
                    (like, like),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM scratchpad ORDER BY pinned DESC, updated_at DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def create_note(self, title: str = "Untitled note", content: str = "") -> dict[str, Any]:
        now = time.time()
        title = title.strip() or "Untitled note"
        with self._lock, self._conn:
            cur = self._conn.execute(
                "INSERT INTO scratchpad (title, content, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
                (title, content, now, now),
            )
            row = self._conn.execute("SELECT * FROM scratchpad WHERE id = ?", (cur.lastrowid,)).fetchone()
            return dict(row)

    def update_note(
        self,
        note_id: int,
        *,
        title: str | None = None,
        content: str | None = None,
        pinned: bool | None = None,
    ) -> dict[str, Any] | None:
        with self._lock, self._conn:
            row = self._conn.execute("SELECT * FROM scratchpad WHERE id = ?", (note_id,)).fetchone()
            if not row:
                return None
            new_title = title.strip() if title is not None else row["title"]
            new_content = content if content is not None else row["content"]
            new_pinned = int(pinned) if pinned is not None else row["pinned"]
            self._conn.execute(
                "UPDATE scratchpad SET title = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?",
                (new_title or "Untitled note", new_content, new_pinned, time.time(), note_id),
            )
            updated = self._conn.execute("SELECT * FROM scratchpad WHERE id = ?", (note_id,)).fetchone()
            return dict(updated)

    def delete_note(self, note_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM scratchpad WHERE id = ?", (note_id,))
            return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()
