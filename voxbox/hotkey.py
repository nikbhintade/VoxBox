"""Global hold-to-talk hotkey listener & interactive key capture via Linux evdev."""

from __future__ import annotations

import logging
import selectors
import threading
import time
from typing import Callable

import evdev
from evdev import ecodes

log = logging.getLogger(__name__)


def parse_key_combo(spec: str) -> set[int]:
    codes: set[int] = set()
    for part in spec.split("+"):
        name = part.strip().upper()
        if not name:
            continue
        if not name.startswith("KEY_"):
            name = f"KEY_{name}"
        code = getattr(ecodes, name, None)
        if code is None:
            raise ValueError(f"Unknown evdev key name: {part!r}")
        codes.add(int(code))
    if not codes:
        raise ValueError(f"Empty hotkey specification: {spec!r}")
    return codes


def code_to_key_name(code: int) -> str | None:
    name = ecodes.KEY.get(code)
    if isinstance(name, list):
        return str(name[0])
    if isinstance(name, str):
        return name
    return None


def capture_next_hotkey(timeout_sec: float = 8.0) -> str | None:
    """Wait for the user to press (and release) a key or combo on any keyboard."""
    sel = selectors.DefaultSelector()
    devs: list[evdev.InputDevice] = []
    try:
        for path in evdev.list_devices():
            try:
                dev = evdev.InputDevice(path)
                if "ydotool" in (dev.name or "").lower():
                    dev.close()
                    continue
                caps = dev.capabilities(verbose=False)
                keys = set(caps.get(ecodes.EV_KEY, ()))
                if ecodes.KEY_A in keys or ecodes.KEY_RIGHTCTRL in keys:
                    devs.append(dev)
                    sel.register(dev, selectors.EVENT_READ)
                else:
                    dev.close()
            except OSError:
                pass

        if not devs:
            return None

        deadline = time.monotonic() + timeout_sec
        held: list[int] = []
        peak_combo: list[int] = []

        while time.monotonic() < deadline:
            remaining = max(0.05, deadline - time.monotonic())
            events = sel.select(timeout=min(0.25, remaining))
            for key, _ in events:
                dev: evdev.InputDevice = key.fileobj  # type: ignore[assignment]
                try:
                    for ev in dev.read():
                        if ev.type != ecodes.EV_KEY or ev.value == 2:
                            continue
                        if ev.code == ecodes.KEY_ESC:
                            return None
                        if ev.value == 1:
                            if ev.code not in held:
                                held.append(ev.code)
                            if len(held) > len(peak_combo):
                                peak_combo = list(held)
                        elif ev.value == 0:
                            if ev.code in held:
                                held.remove(ev.code)
                            if peak_combo and not held:
                                names = [code_to_key_name(c) for c in peak_combo]
                                valid = [n for n in names if n]
                                return "+".join(valid) if valid else None
                except OSError:
                    pass
        return None
    finally:
        for d in devs:
            try:
                sel.unregister(d)
            except Exception:
                pass
            try:
                d.close()
            except Exception:
                pass


class EvdevHotkeyListener:
    """Watches all keyboard evdev nodes for a hold-to-talk key or combo."""

    def __init__(
        self,
        key_spec: str,
        cancel_key_spec: str,
        on_press: Callable[[], None],
        on_release: Callable[[], None],
        on_cancel: Callable[[], None],
        rescan_interval: float = 3.0,
    ) -> None:
        self.target_codes = parse_key_combo(key_spec)
        self.cancel_codes = parse_key_combo(cancel_key_spec) if cancel_key_spec.strip() else set()
        self.on_press = on_press
        self.on_release = on_release
        self.on_cancel = on_cancel
        self.rescan_interval = rescan_interval

        self._stop_event = threading.Event()
        self._paused = threading.Event()
        self._thread: threading.Thread | None = None
        self._devices: dict[str, evdev.InputDevice] = {}
        self._selector = selectors.DefaultSelector()
        self._pressed: set[int] = set()
        self._active = False

    def pause(self) -> None:
        self._paused.set()
        self._pressed.clear()
        self._active = False

    def resume(self) -> None:
        self._pressed.clear()
        self._active = False
        self._paused.clear()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="voxbox-hotkey", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._close_all()

    def _close_all(self) -> None:
        for _, dev in list(self._devices.items()):
            try:
                self._selector.unregister(dev)
            except Exception:
                pass
            try:
                dev.close()
            except Exception:
                pass
        self._devices.clear()

    def _is_matching_keyboard(self, dev: evdev.InputDevice) -> bool:
        if "ydotool" in (dev.name or "").lower():
            return False
        caps = dev.capabilities(verbose=False)
        keys = set(caps.get(ecodes.EV_KEY, ()))
        return bool(keys and (self.target_codes & keys))

    def _scan_devices(self) -> None:
        try:
            paths = set(evdev.list_devices())
        except Exception:
            return

        for path in list(self._devices):
            if path not in paths:
                self._remove_device(path)

        for path in sorted(paths):
            if path in self._devices:
                continue
            try:
                dev = evdev.InputDevice(path)
                if self._is_matching_keyboard(dev):
                    self._devices[path] = dev
                    self._selector.register(dev, selectors.EVENT_READ, data=path)
                    log.info("Listening for hotkey on %s (%s)", path, dev.name)
                else:
                    dev.close()
            except PermissionError:
                log.error("Permission denied opening %s (add user to 'input' group)", path)
            except OSError:
                pass

    def _remove_device(self, path: str) -> None:
        dev = self._devices.pop(path, None)
        if dev is None:
            return
        try:
            self._selector.unregister(dev)
        except Exception:
            pass
        try:
            dev.close()
        except Exception:
            pass

    def _handle_key_event(self, code: int, value: int) -> None:
        if value == 2 or self._paused.is_set():
            return
        if value == 1:
            if self._active and code in self.cancel_codes:
                self._active = False
                try:
                    self.on_cancel()
                except Exception:
                    log.exception("on_cancel failed")
                return
            if code in self.target_codes:
                self._pressed.add(code)
                if not self._active and self.target_codes.issubset(self._pressed):
                    self._active = True
                    try:
                        self.on_press()
                    except Exception:
                        log.exception("on_press failed")
        elif value == 0:
            if code in self.target_codes:
                self._pressed.discard(code)
                if self._active and not self.target_codes.issubset(self._pressed):
                    self._active = False
                    try:
                        self.on_release()
                    except Exception:
                        log.exception("on_release failed")

    def _run(self) -> None:
        self._scan_devices()
        last_scan = time.monotonic()

        while not self._stop_event.is_set():
            now = time.monotonic()
            if now - last_scan >= self.rescan_interval:
                self._scan_devices()
                last_scan = now

            if not self._devices:
                time.sleep(0.5)
                continue

            try:
                events = self._selector.select(timeout=0.5)
            except Exception:
                time.sleep(0.2)
                continue

            for key, _ in events:
                dev: evdev.InputDevice = key.fileobj  # type: ignore[assignment]
                path: str = key.data
                try:
                    for ev in dev.read():
                        if ev.type == ecodes.EV_KEY:
                            self._handle_key_event(ev.code, ev.value)
                except OSError:
                    self._remove_device(path)
                    if self._active:
                        self._active = False
                        self._pressed.clear()
                        try:
                            self.on_cancel()
                        except Exception:
                            pass
                    last_scan = 0.0
