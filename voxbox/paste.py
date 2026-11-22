"""Rock-solid GNOME Wayland text pasting via wl-copy + ydotool."""

from __future__ import annotations

import logging
import os
import subprocess
import time
from pathlib import Path

from .config import PasteConfig

log = logging.getLogger(__name__)


def _ydotool_env() -> dict[str, str]:
    env = os.environ.copy()
    if "YDOTOOL_SOCKET" not in env:
        uid = os.getuid()
        for candidate in (
            Path(f"/run/user/{uid}/.ydotool_socket"),
            Path("/tmp/.ydotool_socket"),
        ):
            if candidate.exists():
                env["YDOTOOL_SOCKET"] = str(candidate)
                break
    return env


def copy_to_clipboard(text: str, also_primary: bool = True) -> None:
    """Copy UTF-8 text to Wayland clipboard (and primary selection).

    stdout/stderr MUST be DEVNULL because wl-copy forks a background process
    to serve Wayland selection offers; capturing pipes would hang forever.
    """
    payload = text.encode("utf-8")
    subprocess.run(
        ["wl-copy", "--type", "text/plain;charset=utf-8"],
        input=payload,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=3.0,
    )
    if also_primary:
        subprocess.run(
            ["wl-copy", "--primary", "--type", "text/plain;charset=utf-8"],
            input=payload,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=3.0,
        )


def paste_text(text: str, config: PasteConfig) -> None:
    """Copy text and inject it into the currently focused Wayland/XWayland window."""
    if not text:
        return
    if config.trailing_space and not text.endswith((" ", "\n")):
        text = text + " "

    mode = config.mode.strip().lower()

    if mode == "type":
        try:
            copy_to_clipboard(text, also_primary=False)
        except Exception:
            pass
        subprocess.run(
            ["ydotool", "type", "--key-delay", "2", "--", text],
            env=_ydotool_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=True,
            timeout=10.0,
        )
        return

    copy_to_clipboard(text, also_primary=True)

    if mode == "clipboard_only":
        return

    if config.delay_ms > 0:
        time.sleep(config.delay_ms / 1000.0)

    # Linux evdev keycodes: 29=LEFTCTRL, 42=LEFTSHIFT, 47=V, 110=INSERT
    if mode == "ctrl_v":
        keys = ["29:1", "47:1", "47:0", "29:0"]
    elif mode == "ctrl_shift_v":
        keys = ["29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
    else:
        keys = ["42:1", "110:1", "110:0", "42:0"]

    res = subprocess.run(
        ["ydotool", "key", *keys],
        env=_ydotool_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=5.0,
    )
    if res.returncode != 0:
        err = res.stderr.decode("utf-8", errors="replace").strip()
        log.error("ydotool key failed (%d): %s (text is still on clipboard)", res.returncode, err)
