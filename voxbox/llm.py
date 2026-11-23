"""Multi-provider LLM dictation post-processor: Local Ollama, Gemini, Claude, OpenAI & OpenAI-compatible."""

from __future__ import annotations

import difflib
import json
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

OLLAMA_RECOMMENDED: list[dict[str, Any]] = [
    {
        "name": "qwen3:1.7b",
        "size_label": "~1.4 GB",
        "vram": "4 GB VRAM / CPU",
        "badge": "Ultra Fast",
        "description": "Tiny footprint for laptops or CPUs; fast basic cleanup.",
    },
    {
        "name": "llama3.2:3b",
        "size_label": "~2.0 GB",
        "vram": "4 GB VRAM",
        "badge": "Lightweight",
        "description": "Fast non-reasoning model with clean punctuation and low latency.",
    },
    {
        "name": "qwen3:4b",
        "size_label": "~2.6 GB",
        "vram": "6 GB VRAM",
        "badge": "Fast",
        "description": "Snappy cleanup and self-correction handling on mid-range GPUs.",
    },
    {
        "name": "gemma3:4b",
        "size_label": "~3.3 GB",
        "vram": "6 GB VRAM",
        "badge": "Natural Prose",
        "description": "Strong phrasing, grammar, and clean formatting in a compact size.",
    },
    {
        "name": "qwen3:8b",
        "size_label": "~5.2 GB",
        "vram": "8 GB VRAM",
        "badge": "Balanced",
        "description": "Great accuracy on technical terms and complex self-corrections.",
    },
    {
        "name": "qwen3:14b",
        "size_label": "~9.3 GB",
        "vram": "16 GB VRAM",
        "badge": "Best Local",
        "description": "Highest local cleanup & formatting quality (~400ms on 16GB+ GPUs).",
    },
]

CLOUD_PROVIDERS: dict[str, Any] = {
    "gemini": {
        "label": "Gemini",
        "models": [
            {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite (Fastest & lowest cost)"},
            {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash (Balanced)"},
            {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash"},
        ],
    },
    "claude": {
        "label": "Claude",
        "models": [
            {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5 (Fastest)"},
            {"id": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5 (Highest quality)"},
            {"id": "claude-3-5-haiku-latest", "label": "Claude 3.5 Haiku"},
        ],
    },
    "openai": {
        "label": "OpenAI",
        "models": [
            {"id": "gpt-4.1-nano", "label": "GPT-4.1 nano (Fastest)"},
            {"id": "gpt-4.1-mini", "label": "GPT-4.1 mini (Balanced)"},
            {"id": "gpt-4o-mini", "label": "GPT-4o mini"},
        ],
    },
    "openai_compatible": {
        "label": "OpenAI-Compatible",
        "presets": [
            {"name": "Groq", "base_url": "https://api.groq.com/openai/v1", "model": "llama-3.3-70b-versatile"},
            {"name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "model": "google/gemini-2.5-flash-lite"},
            {"name": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
            {"name": "Together AI", "base_url": "https://api.together.xyz/v1", "model": "meta-llama/Llama-3.3-70B-Instruct-Turbo"},
            {"name": "Cerebras", "base_url": "https://api.cerebras.ai/v1", "model": "llama-3.3-70b"},
            {"name": "LM Studio (Local)", "base_url": "http://127.0.0.1:1234/v1", "model": "local-model"},
        ],
    },
}


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


class OllamaPullManager:
    """Streams Ollama model pulls with live progress and supports deletion."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pulls: dict[str, dict[str, Any]] = {}

    def catalog(self, base_url: str, active_model: str, is_ollama_active: bool) -> dict[str, Any]:
        installed_list = list_ollama_models(base_url)
        installed_map = {m["name"]: m["size_gb"] for m in installed_list}
        ollama_reachable = bool(installed_list)
        if not ollama_reachable:
            try:
                ollama_reachable = requests.get(f"{base_url.rstrip('/')}/api/version", timeout=1.5).status_code == 200
            except Exception:
                ollama_reachable = False

        with self._lock:
            pulls = {
                k: {
                    "active": v["active"],
                    "status": v["status"],
                    "progress": v["progress"],
                    "completed_mb": v["completed_mb"],
                    "total_mb": v["total_mb"],
                    "error": v["error"],
                }
                for k, v in self._pulls.items()
            }

        seen: set[str] = set()
        items: list[dict[str, Any]] = []

        # Include all recommended VRAM tiers first
        for spec in OLLAMA_RECOMMENDED:
            name = spec["name"]
            seen.add(name)
            inst = name in installed_map
            dl = pulls.get(name)
            items.append(
                {
                    **spec,
                    "size_label": f"{installed_map[name]} GB" if inst else spec["size_label"],
                    "installed": inst,
                    "active": is_ollama_active and active_model == name,
                    "pulling": bool(dl and dl["active"]),
                    "progress": dl["progress"] if dl else 0,
                    "status": dl["status"] if dl else "",
                    "completed_mb": dl["completed_mb"] if dl else 0.0,
                    "total_mb": dl["total_mb"] if dl else 0.0,
                    "error": dl["error"] if dl else "",
                }
            )

        # Include any other user-installed Ollama models not in the recommended list
        for m in installed_list:
            name = m["name"]
            if name in seen:
                continue
            seen.add(name)
            items.append(
                {
                    "name": name,
                    "size_label": f"{m['size_gb']} GB",
                    "vram": "Installed locally",
                    "badge": "Custom",
                    "description": "Local Ollama model already installed on this machine.",
                    "installed": True,
                    "active": is_ollama_active and active_model == name,
                    "pulling": False,
                    "progress": 100,
                    "status": "",
                    "completed_mb": 0.0,
                    "total_mb": 0.0,
                    "error": "",
                }
            )

        # Include any in-progress custom pull not in recommended or installed yet
        for name, dl in pulls.items():
            if name in seen or not dl["active"]:
                continue
            items.append(
                {
                    "name": name,
                    "size_label": f"{dl['total_mb']:.0f} MB" if dl["total_mb"] else "Pulling…",
                    "vram": "Custom Ollama tag",
                    "badge": "Pulling",
                    "description": "Downloading from Ollama registry…",
                    "installed": False,
                    "active": False,
                    "pulling": True,
                    "progress": dl["progress"],
                    "status": dl["status"],
                    "completed_mb": dl["completed_mb"],
                    "total_mb": dl["total_mb"],
                    "error": dl["error"],
                }
            )

        return {"reachable": ollama_reachable, "items": items}

    def start_pull(self, base_url: str, model: str) -> dict[str, Any]:
        model = model.strip()
        if not model:
            raise ValueError("Model name cannot be empty")
        with self._lock:
            existing = self._pulls.get(model)
            if existing and existing["active"]:
                return {"status": "pulling", "model": model}
            cancel_ev = threading.Event()
            self._pulls[model] = {
                "active": True,
                "status": "starting",
                "progress": 0,
                "completed_mb": 0.0,
                "total_mb": 0.0,
                "error": "",
                "cancel": cancel_ev,
            }
        threading.Thread(
            target=self._pull_worker,
            args=(base_url.rstrip("/"), model, cancel_ev),
            name=f"voxbox-ollama-pull-{model}",
            daemon=True,
        ).start()
        return {"status": "started", "model": model}

    def cancel_pull(self, model: str) -> bool:
        with self._lock:
            p = self._pulls.get(model)
            if p and p["active"]:
                p["cancel"].set()
                return True
        return False

    def _pull_worker(self, base_url: str, model: str, cancel_ev: threading.Event) -> None:
        try:
            with requests.post(
                f"{base_url}/api/pull",
                json={"model": model, "stream": True},
                stream=True,
                timeout=30.0,
            ) as r:
                r.raise_for_status()
                for raw_line in r.iter_lines():
                    if cancel_ev.is_set():
                        raise InterruptedError("Pull cancelled")
                    if not raw_line:
                        continue
                    data = json.loads(raw_line.decode("utf-8"))
                    if data.get("error"):
                        raise RuntimeError(str(data["error"]))
                    status = str(data.get("status", ""))
                    total = int(data.get("total", 0) or 0)
                    completed = int(data.get("completed", 0) or 0)
                    pct = min(99, int((completed / total) * 100)) if total > 0 else 0
                    with self._lock:
                        p = self._pulls[model]
                        p["status"] = status
                        if total > 0:
                            p["progress"] = pct
                            p["completed_mb"] = round(completed / (1024 * 1024), 1)
                            p["total_mb"] = round(total / (1024 * 1024), 1)
            with self._lock:
                self._pulls[model]["active"] = False
                self._pulls[model]["progress"] = 100
                self._pulls[model]["status"] = "success"
                self._pulls[model]["error"] = ""
            log.info("Ollama pull complete: %s", model)
        except InterruptedError:
            with self._lock:
                self._pulls.pop(model, None)
        except Exception as e:
            log.error("Ollama pull failed for %s: %s", model, e)
            with self._lock:
                if model in self._pulls:
                    self._pulls[model]["active"] = False
                    self._pulls[model]["error"] = str(e)

    def delete_model(self, base_url: str, model: str, active_model: str, is_ollama_active: bool) -> bool:
        if is_ollama_active and model == active_model:
            raise ValueError("Cannot delete the currently active model. Switch to another model first.")
        r = requests.delete(f"{base_url.rstrip('/')}/api/delete", json={"model": model}, timeout=15.0)
        r.raise_for_status()
        return True


def apply_snippets(text: str, snippets: list[dict[str, Any]]) -> tuple[str, int]:
    if not text or not snippets:
        return text, 0
    hits = 0
    result = text
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


class LLMCleaner:
    """Cleans raw speech transcripts and runs transforms via Ollama, Gemini, Claude, OpenAI, or OpenAI-compatible APIs."""

    def __init__(self, config: LlmConfig) -> None:
        self.config = config
        self._session = requests.Session()
        self._loaded_ollama_models: set[str] = set()
        self._loaded_lock = threading.Lock()

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
        if not self.config.enabled or self.config.provider != "ollama" or not self.config.warmup_on_start:
            return
        threading.Thread(target=self._warmup_ollama, name="voxbox-ollama-warmup", daemon=True).start()

    def _track_ollama_model(self, model: str) -> None:
        if model:
            with self._loaded_lock:
                self._loaded_ollama_models.add(model)

    def unload_ollama(self, models: list[str] | None = None) -> None:
        """Ask Ollama to immediately evict model(s) from VRAM (keep_alive=0)."""
        with self._loaded_lock:
            targets = list(models) if models is not None else list(self._loaded_ollama_models)
        if models is None and self.config.provider == "ollama" and self.config.model and self.config.model not in targets:
            # Also ensure the currently configured Ollama model is unloaded if still warm
            targets.append(self.config.model)

        base = self.config.base_url.rstrip("/")
        for model in targets:
            if not model:
                continue
            try:
                r = self._session.post(
                    f"{base}/api/chat",
                    json={"model": model, "messages": [], "keep_alive": 0},
                    timeout=5.0,
                )
                if r.status_code < 400:
                    log.info("Unloaded Ollama model %s from VRAM", model)
            except Exception as e:
                log.debug("Could not unload Ollama model %s: %s", model, e)
            with self._loaded_lock:
                self._loaded_ollama_models.discard(model)

    def _warmup_ollama(self) -> None:
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
            self._track_ollama_model(self.config.model)
            log.info("Ollama model %s warmed up in %.2fs", self.config.model, time.monotonic() - t0)
        except Exception as e:
            log.warning("Ollama warmup failed: %s", e)

    def _complete(self, system_prompt: str, user_content: str, max_tokens: int, temperature: float = 0.0) -> str:
        provider = (self.config.provider or "ollama").strip().lower()

        if provider == "ollama":
            r = self._session.post(
                f"{self.config.base_url.rstrip('/')}/api/chat",
                json={
                    "model": self.config.model,
                    "think": self.config.think,
                    "stream": False,
                    "keep_alive": self.config.keep_alive,
                    "options": {"temperature": temperature, "num_predict": max_tokens},
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content},
                    ],
                },
                timeout=self.config.timeout_sec,
            )
            r.raise_for_status()
            self._track_ollama_model(self.config.model)
            return str(r.json().get("message", {}).get("content", "")).strip()

        if provider == "gemini":
            api_key = self.config.gemini_api_key.strip()
            model = self.config.gemini_model.strip() or "gemini-2.5-flash-lite"
            if not api_key:
                raise ValueError("Gemini API key is not configured")
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            r = self._session.post(
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json={
                    "systemInstruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{"role": "user", "parts": [{"text": user_content}]}],
                    "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
                },
                timeout=self.config.timeout_sec,
            )
            if r.status_code >= 400:
                raise RuntimeError(self._extract_error(r))
            candidates = r.json().get("candidates", [])
            if not candidates:
                return ""
            parts = candidates[0].get("content", {}).get("parts", [])
            return "".join(str(p.get("text", "")) for p in parts).strip()

        if provider == "claude":
            api_key = self.config.claude_api_key.strip()
            model = self.config.claude_model.strip() or "claude-haiku-4-5"
            if not api_key:
                raise ValueError("Anthropic Claude API key is not configured")
            r = self._session.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_content}],
                },
                timeout=self.config.timeout_sec,
            )
            if r.status_code >= 400:
                raise RuntimeError(self._extract_error(r))
            blocks = r.json().get("content", [])
            return "".join(str(b.get("text", "")) for b in blocks if b.get("type") == "text").strip()

        if provider in ("openai", "openai_compatible"):
            if provider == "openai":
                base = "https://api.openai.com/v1"
                api_key = self.config.openai_api_key.strip()
                model = self.config.openai_model.strip() or "gpt-4o-mini"
                if not api_key:
                    raise ValueError("OpenAI API key is not configured")
            else:
                base = self.config.compat_base_url.strip().rstrip("/")
                api_key = self.config.compat_api_key.strip()
                model = self.config.compat_model.strip()
                if not base:
                    raise ValueError("OpenAI-compatible Base URL is not configured")
                if not model:
                    raise ValueError("OpenAI-compatible Model ID is not configured")

            url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            r = self._session.post(
                url,
                headers=headers,
                json={
                    "model": model,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content},
                    ],
                },
                timeout=self.config.timeout_sec,
            )
            if r.status_code >= 400:
                raise RuntimeError(self._extract_error(r))
            choices = r.json().get("choices", [])
            if not choices:
                return ""
            return str(choices[0].get("message", {}).get("content", "")).strip()

        raise ValueError(f"Unsupported LLM provider: {provider}")

    @staticmethod
    def _extract_error(resp: requests.Response) -> str:
        try:
            body = resp.json()
            err = body.get("error")
            if isinstance(err, dict):
                return f"HTTP {resp.status_code}: {err.get('message') or err}"
            if err:
                return f"HTTP {resp.status_code}: {err}"
        except Exception:
            pass
        return f"HTTP {resp.status_code}: {resp.text[:220]}"

    def test_connection(self) -> dict[str, Any]:
        """Test the currently configured LLM provider & model on a sample transcript."""
        sample = "um so yeah I wanted to ask uh if we can move the meeting to Tuesday actually wait no Wednesday at 3pm"
        t0 = time.monotonic()
        raw_out = self._complete(
            self._build_system_prompt(),
            f"<transcript>\n{sample}\n</transcript>",
            max_tokens=128,
            temperature=0.0,
        )
        cleaned = self._postprocess_output(raw_out)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {
            "ok": True,
            "provider": self.config.active_provider_label(),
            "model": self.config.active_model_name(),
            "latency_ms": elapsed_ms,
            "result": cleaned,
        }

    def clean(
        self,
        raw_text: str,
        *,
        dictionary: list[dict[str, Any]] | None = None,
        snippets: list[dict[str, Any]] | None = None,
        transform_prompt: str | None = None,
    ) -> tuple[str, int, int]:
        raw_text = raw_text.strip()
        if not raw_text:
            return "", 0, 0

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
        est_tokens = min(2048, max(160, int(len(raw_text.split()) * 2.4) + 64))
        try:
            content = self._complete(
                self._build_system_prompt(dictionary, transform_prompt),
                f"<transcript>\n{raw_text}\n</transcript>",
                max_tokens=est_tokens,
                temperature=0.0,
            )
            cleaned = self._postprocess_output(content) or raw_text
        except Exception as e:
            log.error("LLM cleanup (%s) failed (%s); falling back to raw transcript", self.config.provider, e)
            cleaned = raw_text

        cleaned, df = apply_dictionary_replacements(cleaned, dictionary or [])
        cleaned, sf = apply_snippets(cleaned, snippets or [])
        dict_hits = df + sf
        if dictionary:
            raw_low = raw_text.lower()
            for d in dictionary:
                w = str(d.get("word", "")).strip()
                if w and w in cleaned and w not in raw_text and w.lower() in raw_low:
                    dict_hits += 1

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log.info("LLM [%s:%s] (%dms): %r -> %r", self.config.provider, self.config.active_model_name(), elapsed_ms, raw_text, cleaned)
        return cleaned, elapsed_ms, dict_hits

    def run_transform(self, text: str, prompt: str) -> tuple[str, int]:
        t0 = time.monotonic()
        est_tokens = min(2048, max(256, int(len(text.split()) * 2.5) + 128))
        content = self._complete(
            prompt.strip() + "\nOutput ONLY the resulting text without commentary.",
            text,
            max_tokens=est_tokens,
            temperature=0.1,
        )
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


# Backwards-compatible alias
OllamaCleaner = LLMCleaner
