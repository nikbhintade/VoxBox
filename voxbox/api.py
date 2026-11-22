"""Local HTTP + JSON API server powering the VoxBox Desktop Hub (127.0.0.1:8179)."""

from __future__ import annotations

import json
import logging
import mimetypes
import subprocess
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

from .audio import list_microphones
from .config import CONFIG_PATH, DATA_DIR, PROJECT_DIR, STYLE_PROMPTS, friendly_key_name
from .llm import CLOUD_PROVIDERS, list_ollama_models
from .paste import copy_to_clipboard
from .stt import list_whisper_models

if TYPE_CHECKING:
    from .app import VoxBoxApp

log = logging.getLogger(__name__)
WEB_DIR = PROJECT_DIR / "web"


class VoxBoxAPI:
    def __init__(self, app: "VoxBoxApp", port: int = 8179) -> None:
        self.app = app
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        app_ref = self.app

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                log.debug("API: " + format, *args)

            def _send_json(self, data: Any, status: int = 200) -> None:
                body = json.dumps(data, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _read_json(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    return {}
                raw = self.rfile.read(length)
                return json.loads(raw.decode("utf-8"))

            def _serve_static(self, rel_path: str) -> None:
                if rel_path in ("", "/"):
                    rel_path = "index.html"
                rel_path = rel_path.lstrip("/")
                target = (WEB_DIR / rel_path).resolve()
                if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                ctype, _ = mimetypes.guess_type(str(target))
                body = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype or "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                path = parsed.path
                qs = parse_qs(parsed.query)

                try:
                    if not path.startswith("/api/"):
                        self._serve_static(path)
                        return

                    if path == "/api/state":
                        cfg = app_ref.config
                        self._send_json(
                            {
                                "version": "0.2.0",
                                "state": app_ref.current_state,
                                "stt_ready": app_ref.stt.is_ready,
                                "hotkey_label": friendly_key_name(cfg.hotkey.key),
                                "llm_provider_label": cfg.llm.active_provider_label(),
                                "llm_active_model": cfg.llm.active_model_name(),
                                "config": cfg.to_dict(),
                                "styles": STYLE_PROMPTS,
                                "autostart": app_ref.is_autostart_enabled(),
                                "paths": {
                                    "config": str(CONFIG_PATH),
                                    "data": str(DATA_DIR),
                                    "logs": str(DATA_DIR / "logs" / "voxbox.log"),
                                },
                            }
                        )
                    elif path == "/api/dictations":
                        q = qs.get("q", [""])[0]
                        limit = int(qs.get("limit", ["150"])[0])
                        self._send_json({"items": app_ref.db.list_dictations(q, limit)})
                    elif path == "/api/insights":
                        self._send_json(app_ref.db.get_insights())
                    elif path == "/api/dictionary":
                        self._send_json({"items": app_ref.db.list_dictionary()})
                    elif path == "/api/snippets":
                        self._send_json({"items": app_ref.db.list_snippets()})
                    elif path == "/api/transforms":
                        self._send_json({"items": app_ref.db.list_transforms()})
                    elif path == "/api/scratchpad":
                        q = qs.get("q", [""])[0]
                        self._send_json({"items": app_ref.db.list_notes(q)})
                    elif path == "/api/models":
                        self._send_json({"items": app_ref.models.list_models(app_ref.config.stt.resolved_model_path)})
                    elif path == "/api/llm/catalog":
                        cfg_llm = app_ref.config.llm
                        self._send_json(
                            {
                                "provider": cfg_llm.provider,
                                "ollama": app_ref.ollama_pulls.catalog(
                                    cfg_llm.base_url,
                                    cfg_llm.model,
                                    cfg_llm.provider == "ollama",
                                ),
                                "cloud": CLOUD_PROVIDERS,
                            }
                        )
                    elif path == "/api/system/resources":
                        self._send_json(
                            {
                                "microphones": list_microphones(),
                                "whisper_models": app_ref.models.list_models(app_ref.config.stt.resolved_model_path),
                                "ollama_models": list_ollama_models(app_ref.config.llm.base_url),
                                "autostart": app_ref.is_autostart_enabled(),
                            }
                        )
                    else:
                        self._send_json({"error": "Not found"}, status=404)
                except Exception as e:
                    log.exception("GET %s failed", path)
                    self._send_json({"error": str(e)}, status=500)

            def do_POST(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                try:
                    body = self._read_json()

                    if path == "/api/settings":
                        updated = app_ref.update_settings(body)
                        self._send_json({"ok": True, "config": updated.to_dict(), "hotkey_label": friendly_key_name(updated.hotkey.key)})
                    elif path == "/api/hotkey/capture":
                        captured = app_ref.capture_hotkey()
                        self._send_json({"key": captured, "label": friendly_key_name(captured) if captured else None})
                    elif path == "/api/copy":
                        copy_to_clipboard(str(body.get("text", "")), also_primary=True)
                        self._send_json({"ok": True})
                    elif path == "/api/dictations/clear":
                        app_ref.db.clear_dictations()
                        app_ref.tray.update_history([])
                        self._send_json({"ok": True})
                    elif path == "/api/dictionary":
                        item = app_ref.db.add_dictionary_word(str(body.get("word", "")), str(body.get("replacement", "")))
                        self._send_json({"item": item})
                    elif path == "/api/dictionary/import":
                        added = []
                        for raw_line in str(body.get("text", "")).splitlines():
                            line = raw_line.strip()
                            if not line:
                                continue
                            if "->" in line:
                                w, r = line.split("->", 1)
                                added.append(app_ref.db.add_dictionary_word(w, r))
                            elif "," in line:
                                w, r = line.split(",", 1)
                                added.append(app_ref.db.add_dictionary_word(w, r))
                            else:
                                added.append(app_ref.db.add_dictionary_word(line, ""))
                        self._send_json({"count": len(added)})
                    elif path == "/api/snippets":
                        item = app_ref.db.upsert_snippet(str(body.get("trigger", "")), str(body.get("expansion", "")))
                        self._send_json({"item": item})
                    elif path == "/api/snippets/import":
                        added = 0
                        for raw_line in str(body.get("text", "")).splitlines():
                            line = raw_line.strip()
                            if "->" in line:
                                trig, exp = line.split("->", 1)
                                if trig.strip() and exp.strip():
                                    app_ref.db.upsert_snippet(trig, exp)
                                    added += 1
                        self._send_json({"count": added})
                    elif path == "/api/transforms":
                        item = app_ref.db.upsert_transform(
                            str(body.get("name", "")),
                            str(body.get("description", "")),
                            str(body.get("prompt", "")),
                            body.get("id"),
                        )
                        self._send_json({"item": item})
                    elif path == "/api/transforms/reset":
                        items = app_ref.db.reset_default_transforms()
                        self._send_json({"items": items})
                    elif path == "/api/transforms/run":
                        tid = body.get("transform_id")
                        prompt = str(body.get("prompt", ""))
                        if tid is not None and not prompt:
                            tr = app_ref.db.get_transform(int(tid))
                            if not tr:
                                self._send_json({"error": "Transform not found"}, status=404)
                                return
                            prompt = tr["prompt"]
                        out, ms = app_ref.llm.run_transform(str(body.get("text", "")), prompt)
                        self._send_json({"result": out, "latency_ms": ms})
                    elif path == "/api/scratchpad":
                        note = app_ref.db.create_note(str(body.get("title", "Untitled note")), str(body.get("content", "")))
                        self._send_json({"item": note})
                    elif path == "/api/system/autostart":
                        enabled = bool(body.get("enabled", True))
                        ok = app_ref.set_autostart(enabled)
                        self._send_json({"ok": ok, "autostart": app_ref.is_autostart_enabled()})
                    elif path == "/api/system/open-folder":
                        target = DATA_DIR if body.get("kind") != "config" else CONFIG_PATH.parent
                        subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                        self._send_json({"ok": True})
                    elif path == "/api/models/download":
                        res = app_ref.models.start_download(str(body.get("id", "")))
                        self._send_json(res)
                    elif path == "/api/models/cancel":
                        ok = app_ref.models.cancel_download(str(body.get("id", "")))
                        self._send_json({"ok": ok})
                    elif path == "/api/models/select":
                        model_id = str(body.get("id", ""))
                        target = app_ref.models.resolve_path(model_id) if model_id else Path(str(body.get("path", "")))
                        if not target or not target.is_file():
                            self._send_json({"error": "Model is not downloaded yet"}, status=400)
                            return
                        updated = app_ref.update_settings({"stt": {"model_path": str(target)}})
                        self._send_json({"ok": True, "config": updated.to_dict()})
                    elif path == "/api/llm/ollama/pull":
                        res = app_ref.ollama_pulls.start_pull(app_ref.config.llm.base_url, str(body.get("model", "")))
                        self._send_json(res)
                    elif path == "/api/llm/ollama/cancel":
                        ok = app_ref.ollama_pulls.cancel_pull(str(body.get("model", "")))
                        self._send_json({"ok": ok})
                    elif path == "/api/llm/test":
                        res = app_ref.llm.test_connection()
                        self._send_json(res)
                    elif path == "/api/dictate/toggle":
                        app_ref.toggle_manual_recording()
                        self._send_json({"ok": True, "state": app_ref.current_state})
                    else:
                        self._send_json({"error": "Not found"}, status=404)
                except ValueError as e:
                    self._send_json({"error": str(e)}, status=400)
                except Exception as e:
                    log.exception("POST %s failed", path)
                    self._send_json({"error": str(e)}, status=500)

            def do_PATCH(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                try:
                    body = self._read_json()
                    if path.startswith("/api/dictations/"):
                        item_id = int(path.rsplit("/", 1)[-1])
                        updated = app_ref.db.update_dictation(item_id, str(body.get("cleaned_text", "")))
                        if not updated:
                            self._send_json({"error": "Dictation not found"}, status=404)
                            return
                        app_ref.tray.update_history(app_ref.db.list_dictations(limit=8))
                        self._send_json({"item": updated})
                    elif path.startswith("/api/scratchpad/"):
                        note_id = int(path.rsplit("/", 1)[-1])
                        updated = app_ref.db.update_note(
                            note_id,
                            title=body.get("title"),
                            content=body.get("content"),
                            pinned=body.get("pinned"),
                        )
                        if not updated:
                            self._send_json({"error": "Note not found"}, status=404)
                            return
                        self._send_json({"item": updated})
                    else:
                        self._send_json({"error": "Not found"}, status=404)
                except Exception as e:
                    log.exception("PATCH %s failed", path)
                    self._send_json({"error": str(e)}, status=500)

            def do_DELETE(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                try:
                    parts = [p for p in path.split("/") if p]
                    if len(parts) == 4 and parts[:3] == ["api", "llm", "ollama"]:
                        from urllib.parse import unquote
                        model_name = unquote(parts[3])
                        ok = app_ref.ollama_pulls.delete_model(
                            app_ref.config.llm.base_url,
                            model_name,
                            app_ref.config.llm.model,
                            app_ref.config.llm.provider == "ollama",
                        )
                        self._send_json({"ok": ok})
                        return
                    if len(parts) == 3 and parts[0] == "api":
                        resource, raw_id = parts[1], parts[2]
                        if resource == "models":
                            ok = app_ref.models.delete_model(raw_id, app_ref.config.stt.resolved_model_path)
                            self._send_json({"ok": ok})
                            return
                        item_id = int(raw_id)
                        if resource == "dictations":
                            ok = app_ref.db.delete_dictation(item_id)
                            app_ref.tray.update_history(app_ref.db.list_dictations(limit=8))
                        elif resource == "dictionary":
                            ok = app_ref.db.delete_dictionary_word(item_id)
                        elif resource == "snippets":
                            ok = app_ref.db.delete_snippet(item_id)
                        elif resource == "transforms":
                            ok = app_ref.db.delete_transform(item_id)
                        elif resource == "scratchpad":
                            ok = app_ref.db.delete_note(item_id)
                        else:
                            self._send_json({"error": "Unknown resource"}, status=404)
                            return
                        self._send_json({"ok": ok})
                    else:
                        self._send_json({"error": "Not found"}, status=404)
                except ValueError as e:
                    self._send_json({"error": str(e)}, status=400)
                except Exception as e:
                    log.exception("DELETE %s failed", path)
                    self._send_json({"error": str(e)}, status=500)

        self._server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, name="voxbox-api", daemon=True)
        self._thread.start()
        log.info("VoxBox Hub API listening on http://127.0.0.1:%d", self.port)

    def stop(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                pass
            self._server = None
