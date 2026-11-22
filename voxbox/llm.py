"""Local Ollama dictation post-processor: cleanup, dictionary, snippets, styles & transforms."""

from __future__ import annotations

import difflib
import logging
import re
import threading
import time
from typing import Any

import requests

from .config import LlmConfig, STYLE_PROMPTS

log = logging.getLogger(__name__)

_THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_WRAP_TAG_RE = re.compile(r"^\s*<transcript>(.*)</transcript>\s*$", re.DOTALL | re.IGNORECASE)


def list_ollama_models(base_url: str = "http://127.0.0.1:11434") -> list[dict[str, Any]]:
    try:
        r = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=3.0)
        r.raise_for_status()
        models = r.json().get("models", [])
        return [
            {
                "name": m.get("name", ""),
                "size_gb": round(float(m.get("size", 0)) / (1024**3), 1),
            }
            for m in models
            if m.get("name")
        ]
    except Exception:
        return []


def apply_snippets(text: str, snippets: list[dict[str, Any]]) -> tuple[str, int]:
    """Expand voice-triggered snippets (case-insensitive whole-phrase match)."""
    if not text or not snippets:
        return text, 0
    hits = 0
    result = text
    # Sort longest trigger first so specific phrases win over shorter ones.
    for s in sorted(snippets, key=lambda item: len(str(item.get("trigger", ""))), reverse=True):
        trigger = str(s.get("trigger", "")).strip()
        expansion = str(s.get("expansion", "")).strip()
        if not trigger or not expansion:
            continue
        pattern = re.compile(rf"(?<!\w){re.escape(trigger)}(?!\w)", re.IGNORECASE)
        new_result, n = pattern.subn(lambda _m, rep=expansion: rep, result)
        if n > 0:
            hits += n
            result = new_result
    return result, hits


def apply_dictionary_replacements(text: str, dictionary: list[dict[str, Any]]) -> tuple[str, int]:
    """Apply explicit word -> replacement rules and count dictionary hits."""
    if not text or not dictionary:
        return text, 0
    fixes = 0
    result = text
    for entry in dictionary:
        word = str(entry.get("word", "")).strip()
        repl = str(entry.get("replacement", "")).strip()
        if word and repl:
            pattern = re.compile(rf"(?<!\w){re.escape(word)}(?!\w)", re.IGNORECASE)
            result, n = pattern.subn(lambda _m, rep=repl: rep, result)
            fixes += n
    return result, fixes


def count_word_edits(raw: str, cleaned: str) -> int:
    raw_words = raw.lower().split()
    clean_words = cleaned.lower().split()
    sm = difflib.SequenceMatcher(a=raw_words, b=clean_words)
    edits = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            edits += max(i2 - i1, j2 - j1)
    return edits


class OllamaCleaner:
    """Cleans raw speech transcripts and runs custom transforms via local Ollama."""

    def __init__(self, config: LlmConfig) -> None:
        self.config = config
        self._session = requests.Session()

    def _build_system_prompt(
        self,
        dictionary: list[dict[str, Any]] | None = None,
        transform_prompt: str | None = None,
    ) -> str:
        parts = [self.config.system_prompt.strip()]

        style_desc = STYLE_PROMPTS.get(self.config.active_style, STYLE_PROMPTS["default"])
        parts.append(f"Writing style:\n{style_desc}")

        if dictionary:
            terms = []
            for d in dictionary[:80]:
                w = str(d.get("word", "")).strip()
                r = str(d.get("replacement", "")).strip()
                if w and r:
                    terms.append(f"{w} -> {r}")
                elif w:
                    terms.append(w)
            if terms:
                parts.append(
                    "Personal dictionary (always preserve these exact spellings when spoken or closely matched):\n"
                    + ", ".join(terms)
                )

        extra = self.config.custom_instructions.strip()
        if extra:
            parts.append(f"Additional user preferences:\n{extra}")

        if transform_prompt and transform_prompt.strip():
            parts.append(f"Also apply this transform to the cleaned text:\n{transform_prompt.strip()}")

        return "\n\n".join(parts)

    def warmup_async(self) -> None:
        if not self.config.enabled or not self.config.warmup_on_start:
            return
        threading.Thread(target=self._warmup, name="voxbox-ollama-warmup", daemon=True).start()

    def _warmup(self) -> None:
        t0 = time.monotonic()
        try:
            r = self._session.post(
                f"{self.config.base_url.rstrip('/')}/api/chat",
                json={
                    "model": self.config.model,
                    "think": self.config.think,
                    "stream": False,
                    "keep_alive": self.config.keep_alive,
                    "options": {"temperature": 0.0, "num_predict": 1},
                    "messages": [{"role": "user", "content": "ok"}],
                },
                timeout=60.0,
            )
            r.raise_for_status()
            log.info("Ollama model %s warmed up in %.2fs", self.config.model, time.monotonic() - t0)
        except Exception as e:
            log.warning("Ollama warmup failed: %s", e)

    def clean(
        self,
        raw_text: str,
        *,
        dictionary: list[dict[str, Any]] | None = None,
        snippets: list[dict[str, Any]] | None = None,
        transform_prompt: str | None = None,
    ) -> tuple[str, int, int]:
        """Clean raw STT text. Returns (final_text, latency_ms, dict_and_snippet_fixes)."""
        raw_text = raw_text.strip()
        if not raw_text:
            return "", 0, 0

        # Check exact snippet shortcut first (e.g. user said just "work email")
        if snippets:
            exact_norm = raw_text.lower().strip(" .,!?")
            for s in snippets:
                if str(s.get("trigger", "")).strip().lower() == exact_norm:
                    return str(s.get("expansion", "")).strip(), 0, 1

        if not self.config.enabled:
            text, df = apply_dictionary_replacements(raw_text, dictionary or [])
            text, sf = apply_snippets(text, snippets or [])
            return text, 0, df + sf

        t0 = time.monotonic()
        est_tokens = max(160, int(len(raw_text.split()) * 2.4) + 64)
        payload = {
            "model": self.config.model,
            "think": self.config.think,
            "stream": False,
            "keep_alive": self.config.keep_alive,
            "options": {"temperature": 0.0, "num_predict": min(2048, est_tokens)},
            "messages": [
                {"role": "system", "content": self._build_system_prompt(dictionary, transform_prompt)},
                {"role": "user", "content": f"<transcript>\n{raw_text}\n</transcript>"},
            ],
        }

        try:
            r = self._session.post(
                f"{self.config.base_url.rstrip('/')}/api/chat",
                json=payload,
                timeout=self.config.timeout_sec,
            )
            r.raise_for_status()
            content = str(r.json().get("message", {}).get("content", "")).strip()
            cleaned = self._postprocess_output(content) or raw_text
        except Exception as e:
            log.error("Ollama cleanup failed (%s); falling back to raw transcript", e)
            cleaned = raw_text

        cleaned, df = apply_dictionary_replacements(cleaned, dictionary or [])
        cleaned, sf = apply_snippets(cleaned, snippets or [])
        # Count dictionary exact-term matches that appeared after cleanup
        dict_hits = df + sf
        if dictionary:
            raw_low = raw_text.lower()
            for d in dictionary:
                w = str(d.get("word", "")).strip()
                if w and w in cleaned and w not in raw_text and w.lower() in raw_low:
                    dict_hits += 1

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log.info("LLM (%dms): %r -> %r", elapsed_ms, raw_text, cleaned)
        return cleaned, elapsed_ms, dict_hits

    def run_transform(self, text: str, prompt: str) -> tuple[str, int]:
        """Run a standalone transform prompt on arbitrary text (for Transforms / Scratchpad)."""
        t0 = time.monotonic()
        est_tokens = max(256, int(len(text.split()) * 2.5) + 128)
        payload = {
            "model": self.config.model,
            "think": self.config.think,
            "stream": False,
            "keep_alive": self.config.keep_alive,
            "options": {"temperature": 0.1, "num_predict": min(2048, est_tokens)},
            "messages": [
                {"role": "system", "content": prompt.strip() + "\nOutput ONLY the resulting text without commentary."},
                {"role": "user", "content": text},
            ],
        }
        r = self._session.post(
            f"{self.config.base_url.rstrip('/')}/api/chat",
            json=payload,
            timeout=max(self.config.timeout_sec, 30.0),
        )
        r.raise_for_status()
        content = str(r.json().get("message", {}).get("content", "")).strip()
        return self._postprocess_output(content), int((time.monotonic() - t0) * 1000)

    @staticmethod
    def _postprocess_output(text: str) -> str:
        text = _THINK_TAG_RE.sub("", text).strip()
        m = _WRAP_TAG_RE.match(text)
        if m:
            text = m.group(1).strip()
        if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
            inner = text[1:-1].strip()
            if inner:
                text = inner
        return text
