"""Main VoxBox orchestrator connecting evdev hotkey, XWayland Floating Bar, CUDA STT, Ollama LLM, Wayland Paste, Tray & Hub."""

from __future__ import annotations

import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Any

from .api import VoxBoxAPI
from .audio import AudioRecorder, SoundCues
from .config import (
    CACHE_DIR,
    CONFIG_PATH,
    PROJECT_DIR,
    Config,
    friendly_key_name,
    load_config,
    save_config,
)
from .db import VoxBoxDB
from .hotkey import EvdevHotkeyListener, capture_next_hotkey
from .llm import OllamaCleaner, count_word_edits
from .paste import copy_to_clipboard, paste_text
from .stt import WhisperServer
from .tray import VoxBoxTray

log = logging.getLogger(__name__)


class FloatingBarBridge:
    """Manages the standalone XWayland Floating Bar process (voxbox_bar.py)."""

    def __init__(self, on_action: Any) -> None:
        self._on_action = on_action
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._stop_flag = False

    def start(self, *, show_always: bool, hotkey_label: str, theme: str) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return
            self._stop_flag = False
            env = os.environ.copy()
            # Run ONLY the floating bar on XWayland so GNOME honours exact bottom-center positioning.
            env["GDK_BACKEND"] = "x11"
            bar_script = str(PROJECT_DIR / "voxbox_bar.py")
            try:
                self._proc = subprocess.Popen(
                    [sys.executable, bar_script],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    env=env,
                )
            except Exception as e:
                log.error("Failed to launch Floating Bar: %s", e)
                self._proc = None
                return

            threading.Thread(target=self._read_stdout, args=(self._proc,), name="voxbox-bar-in", daemon=True).start()
            threading.Thread(target=self._read_stderr, args=(self._proc,), name="voxbox-bar-err", daemon=True).start()

        self.send({"type": "config", "show_always": show_always, "hotkey": hotkey_label, "theme": theme})

    def send(self, msg: dict[str, Any]) -> None:
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None or proc.stdin is None:
                return
            try:
                proc.stdin.write(json.dumps(msg) + "\n")
                proc.stdin.flush()
            except Exception:
                pass

    def _read_stdout(self, proc: subprocess.Popen[str]) -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                action = data.get("action")
                if action:
                    self._on_action(str(action))
            except Exception:
                pass

    def _read_stderr(self, proc: subprocess.Popen[str]) -> None:
        if proc.stderr is None:
            return
        for line in proc.stderr:
            text = line.strip()
            if text:
                log.debug("[voxbox-bar] %s", text)

    def stop(self) -> None:
        with self._lock:
            self._stop_flag = True
            proc = self._proc
            self._proc = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


class VoxBoxApp:
    def __init__(self, config: Config | None = None, open_hub_on_start: bool = False) -> None:
        self.config = config or load_config()
        self._open_hub_on_start = open_hub_on_start
        self._lock_file = None
        self._busy_lock = threading.Lock()
        self._processing = False
        self._manual_recording = False
        self._press_time = 0.0
        self.current_state = "starting"
        self._hub_proc: subprocess.Popen[bytes] | None = None

        self.db = VoxBoxDB()
        self.sounds = SoundCues(enabled=self.config.audio.sound_effects)
        self.stt = WhisperServer(self.config.stt)
        self.llm = OllamaCleaner(self.config.llm)
        self.api = VoxBoxAPI(self, port=self.config.ui.api_port)
        self.bar = FloatingBarBridge(on_action=self._handle_bar_action)
        self.tray = VoxBoxTray(
            hotkey_label=friendly_key_name(self.config.hotkey.key),
            llm_enabled=self.config.llm.enabled,
            show_flow_bar=self.config.ui.show_flow_bar,
            on_open_hub=self.open_hub,
            on_toggle_llm=self._on_toggle_llm,
            on_toggle_bar=self._on_toggle_bar,
            on_copy_text=self._on_copy_text,
            on_quit=self.shutdown,
        )
        self.recorder = AudioRecorder(self.config.audio, on_level=self._on_audio_level)
        self.hotkey = self._build_hotkey_listener()

    def _build_hotkey_listener(self) -> EvdevHotkeyListener:
        return EvdevHotkeyListener(
            key_spec=self.config.hotkey.key,
            cancel_key_spec=self.config.hotkey.cancel_key,
            on_press=self._on_hotkey_press,
            on_release=self._on_hotkey_release,
            on_cancel=self._on_hotkey_cancel,
        )

    def _acquire_single_instance_lock(self) -> bool:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        lock_path = CACHE_DIR / "voxbox.lock"
        f = lock_path.open("w")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock_file = f
            return True
        except BlockingIOError:
            f.close()
            return False

    def run(self) -> int:
        if not self._acquire_single_instance_lock():
            log.info("VoxBox daemon is already running — opening Hub window.")
            self.open_hub("dictation")
            return 0

        signal.signal(signal.SIGINT, lambda *_: self.shutdown())
        signal.signal(signal.SIGTERM, lambda *_: self.shutdown())

        self.api.start()
        self.bar.start(
            show_always=self.config.ui.show_flow_bar,
            hotkey_label=friendly_key_name(self.config.hotkey.key),
            theme=self.config.ui.theme,
        )
        self.tray.update_history(self.db.list_dictations(limit=8))
        self._set_state("processing", "Loading Whisper…")

        threading.Thread(target=self._bootstrap, name="voxbox-bootstrap", daemon=True).start()

        if self._open_hub_on_start:
            threading.Timer(0.6, self.open_hub, args=("dictation",)).start()

        try:
            self.tray.run_mainloop()
        finally:
            self._cleanup()
        return 0

    def _bootstrap(self) -> None:
        try:
            self.stt.start(wait_timeout=30.0)
            self.llm.warmup_async()
            self.hotkey.start()
            self._set_state("idle", f"Ready · Hold {friendly_key_name(self.config.hotkey.key)}")
            log.info("VoxBox ready! Hold %s to dictate.", friendly_key_name(self.config.hotkey.key))
        except Exception as e:
            log.exception("VoxBox bootstrap failed: %s", e)
            self._set_state("error", str(e)[:60])

    def _set_state(self, state: str, detail: str = "") -> None:
        self.current_state = state
        self.tray.set_state(state, detail)
        self.bar.send(
            {
                "type": "state",
                "state": state,
                "detail": detail,
                "hotkey": friendly_key_name(self.config.hotkey.key),
            }
        )

    def _on_audio_level(self, level: float) -> None:
        self.bar.send({"type": "level", "level": round(level, 3)})

    def _handle_bar_action(self, action: str) -> None:
        if action == "start":
            self._start_recording(manual=True)
        elif action == "stop":
            self._stop_recording(ignore_min_hold=True)
        elif action == "cancel":
            self._on_hotkey_cancel()
        elif action == "open_notetaker":
            self.open_hub("notetaker")
        elif action == "open_hub":
            self.open_hub("dictation")

    def toggle_manual_recording(self) -> None:
        if self.recorder.is_recording:
            self._stop_recording(ignore_min_hold=True)
        else:
            self._start_recording(manual=True)

    def open_hub(self, tab: str = "dictation") -> None:
        hub_script = str(PROJECT_DIR / "voxbox_hub.py")
        url = f"http://127.0.0.1:{self.config.ui.api_port}/?tab={tab}"
        # If Hub is already open, close and relaunch on requested tab or let single-instance focus it.
        if self._hub_proc is not None and self._hub_proc.poll() is None:
            try:
                self._hub_proc.terminate()
                self._hub_proc.wait(timeout=1.0)
            except Exception:
                pass
        try:
            self._hub_proc = subprocess.Popen(
                [sys.executable, hub_script, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as e:
            log.error("Failed to open VoxBox Hub: %s", e)

    def _on_toggle_llm(self, enabled: bool) -> None:
        self.config.llm.enabled = enabled
        self.llm.config.enabled = enabled
        save_config(self.config, CONFIG_PATH)

    def _on_toggle_bar(self, show: bool) -> None:
        self.config.ui.show_flow_bar = show
        save_config(self.config, CONFIG_PATH)
        self.bar.send(
            {
                "type": "config",
                "show_always": show,
                "hotkey": friendly_key_name(self.config.hotkey.key),
                "theme": self.config.ui.theme,
            }
        )

    def _on_copy_text(self, text: str) -> None:
        try:
            copy_to_clipboard(text, also_primary=True)
        except Exception as e:
            log.error("Copy failed: %s", e)

    def capture_hotkey(self) -> str | None:
        self.hotkey.pause()
        try:
            captured = capture_next_hotkey(timeout_sec=8.0)
            if captured:
                self.update_settings({"hotkey": {"key": captured}})
            return captured
        finally:
            self.hotkey.resume()

    def update_settings(self, patch: dict[str, Any]) -> Config:
        old_key = self.config.hotkey.key
        old_stt = (self.config.stt.model_path, self.config.stt.language, self.config.stt.port)

        for section_name, fields in patch.items():
            if not isinstance(fields, dict):
                continue
            section = getattr(self.config, section_name, None)
            if section is None:
                continue
            for k, v in fields.items():
                if hasattr(section, k):
                    setattr(section, k, v)

        save_config(self.config, CONFIG_PATH)

        # Propagate live updates
        self.sounds.enabled = self.config.audio.sound_effects
        self.recorder.config = self.config.audio
        self.llm.config = self.config.llm

        if self.config.hotkey.key != old_key:
            self.hotkey.stop()
            self.hotkey = self._build_hotkey_listener()
            self.hotkey.start()

        new_stt = (self.config.stt.model_path, self.config.stt.language, self.config.stt.port)
        if new_stt != old_stt:
            self.stt.config = self.config.stt
            threading.Thread(target=self._restart_stt, daemon=True).start()

        hotkey_lbl = friendly_key_name(self.config.hotkey.key)
        self.tray.sync_settings(hotkey_lbl, self.config.llm.enabled, self.config.ui.show_flow_bar)
        self.bar.send(
            {
                "type": "config",
                "show_always": self.config.ui.show_flow_bar,
                "hotkey": hotkey_lbl,
                "theme": self.config.ui.theme,
            }
        )
        return self.config

    def _restart_stt(self) -> None:
        self._set_state("processing", "Reloading Whisper…")
        try:
            self.stt.stop()
            self.stt.start(wait_timeout=30.0)
            self._set_state("idle")
        except Exception as e:
            log.error("STT reload failed: %s", e)
            self._set_state("error", "STT reload failed")

    def is_autostart_enabled(self) -> bool:
        try:
            res = subprocess.run(
                ["systemctl", "--user", "is-enabled", "voxbox.service"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2.0,
            )
            return res.stdout.strip() == "enabled"
        except Exception:
            return False

    def set_autostart(self, enabled: bool) -> bool:
        action = "enable" if enabled else "disable"
        try:
            res = subprocess.run(
                ["systemctl", "--user", action, "voxbox.service"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5.0,
            )
            return res.returncode == 0
        except Exception:
            return False

    # ---------- Recording & Pipeline ----------

    def _start_recording(self, manual: bool = False) -> None:
        with self._busy_lock:
            if self._processing or self.recorder.is_recording:
                return
            self._manual_recording = manual
            self._press_time = time.monotonic()
            if self.recorder.start():
                self.sounds.play_start()
                self._set_state("recording")

    def _stop_recording(self, ignore_min_hold: bool = False) -> None:
        if not self.recorder.is_recording:
            return
        held_ms = (time.monotonic() - self._press_time) * 1000.0
        wav_bytes, duration_sec, peak_rms = self.recorder.stop()
        self._manual_recording = False

        if not ignore_min_hold and (held_ms < self.config.hotkey.min_hold_ms or duration_sec < 0.15):
            self._set_state("idle")
            return

        self.sounds.play_stop()

        if not wav_bytes or peak_rms < self.config.audio.silence_rms_threshold:
            log.info("Discarded silent audio (peak_rms=%.5f)", peak_rms)
            self._set_state("idle")
            return

        threading.Thread(
            target=self._process_audio,
            args=(wav_bytes, duration_sec),
            name="voxbox-pipeline",
            daemon=True,
        ).start()

    def _on_hotkey_press(self) -> None:
        self._start_recording(manual=False)

    def _on_hotkey_release(self) -> None:
        if not self._manual_recording:
            self._stop_recording(ignore_min_hold=False)

    def _on_hotkey_cancel(self) -> None:
        if self.recorder.is_recording:
            self.recorder.cancel()
            self._manual_recording = False
            self.sounds.play_cancel()
            self._set_state("idle")
            log.info("Recording cancelled")

    def _process_audio(self, wav_bytes: bytes, duration_sec: float) -> None:
        with self._busy_lock:
            self._processing = True
        try:
            self._set_state("processing", "Transcribing…")
            dictionary = self.db.list_dictionary()
            snippets = self.db.list_snippets()
            vocab = [str(d["replacement"] or d["word"]) for d in dictionary]

            raw_text, stt_ms = self.stt.transcribe(wav_bytes, duration_sec, extra_vocab=vocab)
            if not raw_text:
                self._set_state("idle")
                return

            transform_prompt = None
            transform_name = ""
            if self.config.llm.auto_transform_id is not None:
                tr = self.db.get_transform(int(self.config.llm.auto_transform_id))
                if tr:
                    transform_prompt = tr["prompt"]
                    transform_name = tr["name"]

            llm_ms = 0
            dict_fixes = 0
            final_text = raw_text
            if self.config.llm.enabled:
                self._set_state("processing", "Polishing…")
                final_text, llm_ms, dict_fixes = self.llm.clean(
                    raw_text,
                    dictionary=dictionary,
                    snippets=snippets,
                    transform_prompt=transform_prompt,
                )

            if not final_text:
                self._set_state("idle")
                return

            # Return bar to resting state right before pasting so target focus is untouched.
            self._set_state("idle")
            time.sleep(0.025)

            paste_text(final_text, self.config.paste)

            fixes_count = count_word_edits(raw_text, final_text)
            self.db.add_dictation(
                raw_text=raw_text,
                cleaned_text=final_text,
                duration_sec=duration_sec,
                stt_ms=stt_ms,
                llm_ms=llm_ms,
                fixes_count=fixes_count,
                dict_fixes=dict_fixes,
                style=self.config.llm.active_style,
                transform_name=transform_name,
            )
            self.tray.update_history(self.db.list_dictations(limit=8))
            log.info("Done in %dms (STT %dms + LLM %dms): %s", stt_ms + llm_ms, stt_ms, llm_ms, final_text)
        except Exception as e:
            log.exception("Dictation pipeline failed: %s", e)
            self._set_state("error", str(e)[:50])
            time.sleep(2.5)
            self._set_state("idle")
        finally:
            with self._busy_lock:
                self._processing = False

    def shutdown(self) -> None:
        log.info("Shutting down VoxBox…")
        self.tray.quit_mainloop()

    def _cleanup(self) -> None:
        for fn in (self.hotkey.stop, self.recorder.cancel, self.bar.stop, self.stt.stop, self.api.stop, self.db.close):
            try:
                fn()
            except Exception:
                pass
        if self._hub_proc is not None and self._hub_proc.poll() is None:
            try:
                self._hub_proc.terminate()
            except Exception:
                pass
        if self._lock_file is not None:
            try:
                self._lock_file.close()
            except Exception:
                pass
