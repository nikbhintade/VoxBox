"""Managed CUDA-accelerated whisper-server client and lifecycle controller."""

from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from pathlib import Path

import requests

from .config import DATA_DIR, SttConfig

log = logging.getLogger(__name__)

_ARTIFACT_RE = re.compile(
    r"^\s*(?:\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE)\]|"
    r"\((?:music|silence|applause|laughter|sighs|blank audio)\))\s*$",
    re.IGNORECASE,
)
_HALLUCINATIONS = {
    "thank you.",
    "thank you for watching.",
    "thanks for watching.",
    "you",
    ".",
    "...",
}


def list_whisper_models() -> list[dict[str, str]]:
    models_dir = DATA_DIR / "models"
    results: list[dict[str, str]] = []
    if models_dir.exists():
        for p in sorted(models_dir.glob("*.bin")):
            size_mb = p.stat().st_size / (1024 * 1024)
            results.append({"path": str(p), "name": f"{p.name} ({size_mb:.0f} MB)"})
    return results


class WhisperServer:
    """Runs whisper-server locally on GPU and transcribes WAV buffers over HTTP."""

    def __init__(self, config: SttConfig) -> None:
        self.config = config
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._session = requests.Session()
        self._ready = False

    @property
    def base_url(self) -> str:
        return f"http://{self.config.host}:{self.config.port}"

    @property
    def is_ready(self) -> bool:
        return self._ready and self._proc is not None and self._proc.poll() is None

    def start(self, wait_timeout: float = 30.0) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None and self._ready:
                return
            self._stop_locked()

            bin_path = self.config.resolved_server_bin
            model_path = self.config.resolved_model_path
            if not bin_path.exists():
                raise FileNotFoundError(f"whisper-server binary not found: {bin_path}")
            if not model_path.exists():
                raise FileNotFoundError(f"Whisper model not found: {model_path}")

            cmd = [
                str(bin_path),
                "--model",
                str(model_path),
                "--host",
                self.config.host,
                "--port",
                str(self.config.port),
                "--language",
                self.config.language,
                "--threads",
                "4",
                "--no-timestamps",
                "--suppress-nst",
            ]
            log.info("Starting whisper-server (CUDA): %s", " ".join(cmd))
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

        deadline = time.monotonic() + wait_timeout
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                err = ""
                if self._proc.stderr is not None:
                    err = self._proc.stderr.read().decode("utf-8", errors="replace")[-1000:]
                raise RuntimeError(f"whisper-server exited early ({self._proc.returncode}): {err}")
            if self._health_check():
                self._ready = True
                log.info("whisper-server ready at %s", self.base_url)
                threading.Thread(target=self._drain_stderr, args=(self._proc,), daemon=True).start()
                return
            time.sleep(0.2)

        self.stop()
        raise TimeoutError(f"whisper-server did not become ready within {wait_timeout}s")

    def _drain_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        if proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    log.debug("[whisper-server] %s", text)
        except Exception:
            pass

    def _health_check(self) -> bool:
        for ep in ("/health", "/"):
            try:
                r = self._session.get(f"{self.base_url}{ep}", timeout=1.0)
                if r.status_code == 200:
                    return True
            except requests.RequestException:
                pass
        return False

    def _ensure_running(self) -> None:
        if self._proc is None or self._proc.poll() is not None or not self._ready:
            log.warning("whisper-server not running; restarting...")
            self.start(wait_timeout=20.0)

    def transcribe(
        self,
        wav_bytes: bytes,
        duration_sec: float,
        extra_vocab: list[str] | None = None,
    ) -> tuple[str, int]:
        """Transcribe WAV bytes and return (text, latency_ms)."""
        self._ensure_running()
        t0 = time.monotonic()

        prompt_parts: list[str] = []
        if self.config.initial_prompt.strip():
            prompt_parts.append(self.config.initial_prompt.strip())
        if extra_vocab:
            prompt_parts.append(", ".join(extra_vocab[:60]))

        data: dict[str, str] = {
            "response_format": "json",
            "temperature": "0.0",
            "temperature_inc": "0.2",
            "language": self.config.language,
        }
        if prompt_parts:
            data["prompt"] = " ".join(prompt_parts)

        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        try:
            resp = self._session.post(
                f"{self.base_url}/inference",
                files=files,
                data=data,
                timeout=30.0,
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            log.error("whisper-server request failed: %s — restarting once", e)
            self._ready = False
            self.start(wait_timeout=20.0)
            resp = self._session.post(
                f"{self.base_url}/inference",
                files=files,
                data=data,
                timeout=30.0,
            )
            resp.raise_for_status()

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        payload = resp.json()
        raw_text = str(payload.get("text", "")).strip()
        text = self._sanitize(raw_text, duration_sec)
        log.info("STT (%dms, %.2fs audio): %r", elapsed_ms, duration_sec, text)
        return text, elapsed_ms

    @staticmethod
    def _sanitize(text: str, duration_sec: float) -> str:
        cleaned = " ".join(text.split()).strip()
        if not cleaned or _ARTIFACT_RE.match(cleaned):
            return ""
        if duration_sec < 1.2 and cleaned.lower() in _HALLUCINATIONS:
            return ""
        return cleaned

    def _stop_locked(self) -> None:
        self._ready = False
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2.0)
            except Exception:
                pass

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()
