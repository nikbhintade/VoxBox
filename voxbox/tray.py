"""GNOME top-bar system tray icon using GTK3 + AyatanaAppIndicator3."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any, Callable

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")

from gi.repository import AyatanaAppIndicator3, GLib, Gtk

from .config import CACHE_DIR, CONFIG_PATH

log = logging.getLogger(__name__)


def _ensure_tray_icons() -> Path:
    icon_dir = CACHE_DIR / "icons"
    icon_dir.mkdir(parents=True, exist_ok=True)
    specs = {
        "voxbox-idle": ("#E5E7EB", None),
        "voxbox-recording": ("#FFFFFF", "#EF4444"),
        "voxbox-processing": ("#111827", "#F59E0B"),
        "voxbox-error": ("#FFFFFF", "#DC2626"),
    }
    for name, (fg, bg) in specs.items():
        path = icon_dir / f"{name}.svg"
        bg_el = f'<circle cx="12" cy="12" r="11" fill="{bg}"/>' if bg else ""
        # Stylized VoxBox vertical audio-bars mark
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  {bg_el}
  <rect x="4.5" y="9" width="2.4" height="6" rx="1.2" fill="{fg}"/>
  <rect x="8.8" y="5.5" width="2.4" height="13" rx="1.2" fill="{fg}"/>
  <rect x="13.1" y="7.5" width="2.4" height="9" rx="1.2" fill="{fg}"/>
  <rect x="17.4" y="10" width="2.4" height="4" rx="1.2" fill="{fg}"/>
</svg>
"""
        path.write_text(svg, encoding="utf-8")
    return icon_dir


class VoxBoxTray:
    def __init__(
        self,
        *,
        hotkey_label: str,
        llm_enabled: bool,
        show_flow_bar: bool,
        on_open_hub: Callable[[str], None],
        on_toggle_llm: Callable[[bool], None],
        on_toggle_bar: Callable[[bool], None],
        on_copy_text: Callable[[str], None],
        on_quit: Callable[[], None],
    ) -> None:
        self._hotkey_label = hotkey_label
        self._llm_enabled = llm_enabled
        self._show_bar = show_flow_bar
        self._on_open_hub = on_open_hub
        self._on_toggle_llm = on_toggle_llm
        self._on_toggle_bar = on_toggle_bar
        self._on_copy_text = on_copy_text
        self._on_quit = on_quit
        self._updating = False
        self._last_text = ""

        icon_dir = _ensure_tray_icons()
        self._indicator = AyatanaAppIndicator3.Indicator.new(
            "voxbox",
            "voxbox-idle",
            AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS,
        )
        self._indicator.set_icon_theme_path(str(icon_dir))
        self._indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)

        self._status_item: Gtk.MenuItem | None = None
        self._llm_item: Gtk.CheckMenuItem | None = None
        self._bar_item: Gtk.CheckMenuItem | None = None
        self._history_menu: Gtk.Menu | None = None
        self._build_menu()

    def _build_menu(self) -> None:
        menu = Gtk.Menu()

        open_item = Gtk.MenuItem(label="Open VoxBox")
        open_item.connect("activate", lambda *_: self._on_open_hub("dictation"))
        menu.append(open_item)

        self._status_item = Gtk.MenuItem(label=f"Ready · Hold {self._hotkey_label}")
        self._status_item.set_sensitive(False)
        menu.append(self._status_item)

        menu.append(Gtk.SeparatorMenuItem())

        self._llm_item = Gtk.CheckMenuItem(label="AI Cleanup (Ollama)")
        self._llm_item.set_active(self._llm_enabled)
        self._llm_item.connect("toggled", self._handle_llm_toggle)
        menu.append(self._llm_item)

        self._bar_item = Gtk.CheckMenuItem(label="Show Floating Bar")
        self._bar_item.set_active(self._show_bar)
        self._bar_item.connect("toggled", self._handle_bar_toggle)
        menu.append(self._bar_item)

        menu.append(Gtk.SeparatorMenuItem())

        copy_last = Gtk.MenuItem(label="Copy Last Transcript")
        copy_last.connect("activate", lambda *_: self._last_text and self._on_copy_text(self._last_text))
        menu.append(copy_last)

        history_parent = Gtk.MenuItem(label="Recent History")
        self._history_menu = Gtk.Menu()
        empty = Gtk.MenuItem(label="(Empty)")
        empty.set_sensitive(False)
        self._history_menu.append(empty)
        history_parent.set_submenu(self._history_menu)
        menu.append(history_parent)

        menu.append(Gtk.SeparatorMenuItem())

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", lambda *_: self._on_open_hub("settings"))
        menu.append(settings_item)

        open_cfg = Gtk.MenuItem(label="Open config.toml")
        open_cfg.connect("activate", self._open_config)
        menu.append(open_cfg)

        menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit VoxBox")
        quit_item.connect("activate", lambda *_: self._on_quit())
        menu.append(quit_item)

        menu.show_all()
        self._indicator.set_menu(menu)

    def _handle_llm_toggle(self, item: Gtk.CheckMenuItem) -> None:
        if not self._updating:
            self._llm_enabled = item.get_active()
            self._on_toggle_llm(self._llm_enabled)

    def _handle_bar_toggle(self, item: Gtk.CheckMenuItem) -> None:
        if not self._updating:
            self._show_bar = item.get_active()
            self._on_toggle_bar(self._show_bar)

    def _open_config(self, _item: Gtk.MenuItem) -> None:
        subprocess.Popen(["xdg-open", str(CONFIG_PATH)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    def set_state(self, state: str, detail: str = "") -> None:
        GLib.idle_add(self._apply_state, state, detail)

    def _apply_state(self, state: str, detail: str) -> bool:
        if state == "recording":
            self._indicator.set_icon_full("voxbox-recording", "Recording")
            self._indicator.set_label(" Rec", " Rec")
            if self._status_item:
                self._status_item.set_label("Listening…")
        elif state == "processing":
            self._indicator.set_icon_full("voxbox-processing", "Processing")
            self._indicator.set_label(" AI", " AI")
            if self._status_item:
                self._status_item.set_label(detail or "Polishing…")
        elif state == "error":
            self._indicator.set_icon_full("voxbox-error", "Error")
            self._indicator.set_label("", "")
            if self._status_item:
                self._status_item.set_label(f"Error: {detail}" if detail else "Error")
        else:
            self._indicator.set_icon_full("voxbox-idle", "Ready")
            self._indicator.set_label("", "")
            if self._status_item:
                self._status_item.set_label(detail or f"Ready · Hold {self._hotkey_label}")
        return False

    def sync_settings(self, hotkey_label: str, llm_enabled: bool, show_bar: bool) -> None:
        GLib.idle_add(self._apply_sync, hotkey_label, llm_enabled, show_bar)

    def _apply_sync(self, hotkey_label: str, llm_enabled: bool, show_bar: bool) -> bool:
        self._hotkey_label = hotkey_label
        self._llm_enabled = llm_enabled
        self._show_bar = show_bar
        self._updating = True
        try:
            if self._llm_item:
                self._llm_item.set_active(llm_enabled)
            if self._bar_item:
                self._bar_item.set_active(show_bar)
            if self._status_item:
                self._status_item.set_label(f"Ready · Hold {hotkey_label}")
        finally:
            self._updating = False
        return False

    def update_history(self, items: list[dict[str, Any]]) -> None:
        GLib.idle_add(self._apply_history, items)

    def _apply_history(self, items: list[dict[str, Any]]) -> bool:
        if self._history_menu is None:
            return False
        for child in self._history_menu.get_children():
            self._history_menu.remove(child)
        if not items:
            empty = Gtk.MenuItem(label="(Empty)")
            empty.set_sensitive(False)
            self._history_menu.append(empty)
        else:
            self._last_text = str(items[0].get("cleaned_text", ""))
            for row in items[:8]:
                text = str(row.get("cleaned_text", ""))
                preview = text.replace("\n", " ")
                if len(preview) > 54:
                    preview = preview[:51] + "…"
                item = Gtk.MenuItem(label=preview)
                item.connect("activate", lambda _w, t=text: self._on_copy_text(t))
                self._history_menu.append(item)
        self._history_menu.show_all()
        return False

    def run_mainloop(self) -> None:
        Gtk.main()

    def quit_mainloop(self) -> None:
        GLib.idle_add(Gtk.main_quit)
