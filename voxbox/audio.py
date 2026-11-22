"""PipeWire audio recording, live RMS metering, microphone listing, audio mute & subtle chimes."""

from __future__ import annotations

import io
import logging
import math
import re
import struct
import subprocess
import threading
import time
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from .config import AudioConfig, CACHE_DIR

log = logging.getLogger(__name__)


def list_microphones() -> list[dict[str, str]]:
    """List available PipeWire audio input sources via wpctl."""
    mics: list[dict[str, str]] = [{"id": "", "name": "System Default Microphone"}]
    try:
        out = subprocess.check_output(["wpctl", "status", "-n"], text=True, timeout=3.0)
        in_audio = False
        in_sources = False
        for line in out.splitlines():
            if line.startswith("Audio"):
                in_audio = True
                continue
            if in_audio and line and not line[0].isspace() and not line.startswith("├") and not line.startswith("└") and not line.startswith("│"):
                break
            if not in_audio:
                continue
            if "Sources:" in line:
                in_sources = True
                continue
            if in_sources and ("Filters:" in line or "Streams:" in line or "Sinks:" in line):
                in_sources = False
                continue
            if in_sources:
                m = re.search(r"(\*)?\s*(\d+)\.\s+([^\[]+)", line)
                if m:
                    is_def = bool(m.group(1))
                    node_name = m.group(3).strip()
                    label = f"{node_name} (default)" if is_def else node_name
                    mics.append({"id": node_name, "name": label})
    except Exception as e:
        log.debug("wpctl status failed: %s", e)
    return mics


class SystemAudioMuter:
    """Temporarily mutes default audio output sink while dictating (optional)."""

    def __init__(self) -> None:
        self._muted_by_us = False

    def mute(self) -> None:
        try:
            out = subprocess.check_output(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"], text=True, timeout=1.5)
            if "[MUTED]" in out:
                self._muted_by_us = False
                return
            subprocess.run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1"], timeout=1.5, check=False)
            self._muted_by_us = True
        except Exception:
            self._muted_by_us = False

    def unmute(self) -> None:
        if not self._muted_by_us:
            return
        self._muted_by_us = False
        try:
            subprocess.run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "0"], timeout=1.5, check=False)
        except Exception:
            pass


def _generate_chime_wav(path: Path, freqs: list[tuple[float, float]], volume: float = 0.14) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 44100
    samples: list[int] = []
    for freq, dur in freqs:
        n = int(rate * dur)
        for i in range(n):
            t = i / rate
            env = max(0.0, math.sin(math.pi * i / max(1, n - 1))) ** 1.2
            val = math.sin(2.0 * math.pi * freq * t) * volume * env
            samples.append(max(-32767, min(32767, int(val * 32767))))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


class SoundCues:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        sounds_dir = CACHE_DIR / "sounds"
        self._start_wav = _generate_chime_wav(sounds_dir / "start.wav", [(660.0, 0.05), (880.0, 0.06)], volume=0.11)
        self._stop_wav = _generate_chime_wav(sounds_dir / "stop.wav", [(587.0, 0.045), (440.0, 0.06)], volume=0.10)
        self._cancel_wav = _generate_chime_wav(sounds_dir / "cancel.wav", [(330.0, 0.08)], volume=0.10)

    def _play(self, path: Path) -> None:
        if not self.enabled:
            return
        try:
            subprocess.Popen(
                ["pw-play", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as e:
            log.debug("Failed to play cue %s: %s", path.name, e)

    def play_start(self) -> None:
        self._play(self._start_wav)

    def play_stop(self) -> None:
        self._play(self._stop_wav)

    def play_cancel(self) -> None:
        self._play(self._cancel_wav)


class AudioRecorder:
    """Captures 16 kHz mono s16 PCM via native PipeWire `pw-record`."""

    def __init__(
        self,
        config: AudioConfig,
        on_level: Callable[[float], None] | None = None,
    ) -> None:
        self.config = config
        self.on_level = on_level
        self._proc: subprocess.Popen[bytes] | None = None
        self._reader_thread: threading.Thread | None = None
        self._chunks: list[bytes] = []
        self._lock = threading.Lock()
        self._recording = False
        self._peak_rms = 0.0
        self._muter = SystemAudioMuter()

    @property
    def is_recording(self) -> bool:
        with self._lock:
            return self._recording

    def start(self) -> bool:
        with self._lock:
            if self._recording:
                return False
            self._chunks = []
            self._peak_rms = 0.0

            if self.config.mute_while_dictating:
                self._muter.mute()

            cmd = [
                "pw-record",
                f"--rate={self.config.sample_rate}",
                "--channels=1",
                "--format=s16",
                "--raw",
            ]
            if self.config.device:
                cmd.extend(["--target", self.config.device])
            cmd.append("-")

            try:
                self._proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
            except Exception as e:
                log.error("Failed to start pw-record: %s", e)
                self._muter.unmute()
                self._proc = None
                return False

            self._recording = True
            self._reader_thread = threading.Thread(
                target=self._read_loop,
                args=(self._proc,),
                name="voxbox-audio",
                daemon=True,
            )
            self._reader_thread.start()
            return True

    def _read_loop(self, proc: subprocess.Popen[bytes]) -> None:
        chunk_bytes = int(self.config.sample_rate * 0.04) * 2
        stdout = proc.stdout
        if stdout is None:
            return
        while True:
            data = stdout.read(chunk_bytes)
            if not data:
                break
            with self._lock:
                self._chunks.append(data)
            if len(data) >= 2:
                even_len = len(data) & ~1
                samples = np.frombuffer(data[:even_len], dtype=np.int16).astype(np.float32) / 32768.0
                rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
                if rms > self._peak_rms:
                    self._peak_rms = rms
                if self.on_level is not None:
                    level = min(1.0, rms * 11.0)
                    try:
                        self.on_level(level)
                    except Exception:
                        pass

    def stop(self) -> tuple[bytes, float, float]:
        with self._lock:
            if not self._recording:
                return b"", 0.0, 0.0
            self._recording = False
            proc = self._proc
            self._proc = None
            reader = self._reader_thread
            self._reader_thread = None

        self._muter.unmute()

        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)
            except Exception:
                pass

        if reader is not None:
            reader.join(timeout=1.5)

        with self._lock:
            pcm = b"".join(self._chunks)
            self._chunks = []
            peak_rms = self._peak_rms

        if len(pcm) % 2:
            pcm = pcm[:-1]

        duration = len(pcm) / (self.config.sample_rate * 2) if pcm else 0.0
        if not pcm:
            return b"", 0.0, 0.0

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self.config.sample_rate)
            wf.writeframes(pcm)
        return buf.getvalue(), duration, peak_rms

    def cancel(self) -> None:
        self.stop()
