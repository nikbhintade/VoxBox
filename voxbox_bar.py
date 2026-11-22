#!/usr/bin/env python3
"""VoxBox Floating Bar (XWayland bottom-center overlay).

Three states modeled after Wispr Flow's Flow Bar:
  1. Resting (idle, when show_always=True): thin translucent dark bar with subtle border.
  2. Hover: expands into [Dictate <Hotkey>] tooltip + [Mic] & [Notetaker] pill buttons.
  3. Recording / Processing: dark capsule with [X] cancel, live 9-dot waveform, [✓] confirm.

Runs under GDK_BACKEND=x11 (XWayland) so GNOME Mutter honours exact bottom-center
placement while never stealing keyboard focus from active Wayland/XWayland apps.
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
from collections import deque

# Enforce XWayland before importing GTK so bottom-center move() works on GNOME Wayland.
os.environ.setdefault("GDK_BACKEND", "x11")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")

import cairo
from gi.repository import Gdk, GLib, Gtk


def _emit(action: str) -> None:
    try:
        sys.stdout.write(json.dumps({"action": action}) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _rounded_rect(cr: cairo.Context, x: float, y: float, w: float, h: float, r: float) -> None:
    r = min(r, w / 2.0, h / 2.0)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


class FloatingBarWindow(Gtk.Window):
    WIN_W = 280
    WIN_H = 104

    def __init__(self) -> None:
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self._state = "idle"  # idle | recording | processing | error
        self._detail = ""
        self._hotkey = "Right Ctrl"
        self._show_always = True
        self._hovered = False
        self._hover_target = ""  # mic | notetaker | cancel | confirm | ""
        self._leave_timer: int | None = None
        self._levels: deque[float] = deque([0.08] * 9, maxlen=9)
        self._phase = 0.0
        self._tick_id: int | None = None

        self.set_title("VoxBox Bar")
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_accept_focus(False)
        self.set_focus_on_map(False)
        self.set_can_focus(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.set_app_paintable(True)
        self.set_default_size(self.WIN_W, self.WIN_H)
        self.set_size_request(self.WIN_W, self.WIN_H)
        self.stick()

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)

        self.add_events(
            Gdk.EventMask.ENTER_NOTIFY_MASK
            | Gdk.EventMask.LEAVE_NOTIFY_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.BUTTON_PRESS_MASK
        )
        self.connect("draw", self._on_draw)
        self.connect("realize", self._on_realize)
        self.connect("enter-notify-event", self._on_enter)
        self.connect("leave-notify-event", self._on_leave)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("button-press-event", self._on_click)

    def _on_realize(self, _widget: Gtk.Widget) -> None:
        self._position_bottom_center()
        self._update_input_region()

    def _position_bottom_center(self) -> None:
        display = Gdk.Display.get_default()
        if display is None:
            return
        mon = display.get_primary_monitor() or display.get_monitor(0)
        if mon is None:
            return
        geo = mon.get_geometry()
        x = geo.x + (geo.width - self.WIN_W) // 2
        y = geo.y + geo.height - self.WIN_H - 10
        self.move(x, y)

    # ---------- Geometry helpers ----------

    def _resting_rect(self) -> tuple[int, int, int, int]:
        w, h = 58, 7
        return ((self.WIN_W - w) // 2, self.WIN_H - h - 4, w, h)

    def _hover_mic_rect(self) -> tuple[int, int, int, int]:
        # Centered pair: mic pill (66x38) + 8px gap + notetaker circle (38x38) => total 112px
        start_x = (self.WIN_W - 112) // 2
        y = self.WIN_H - 42
        return (start_x, y, 66, 38)

    def _hover_note_rect(self) -> tuple[int, int, int, int]:
        mx, my, mw, _ = self._hover_mic_rect()
        return (mx + mw + 8, my, 38, 38)

    def _active_pill_rect(self) -> tuple[int, int, int, int]:
        w, h = 186, 44
        return ((self.WIN_W - w) // 2, self.WIN_H - h - 4, w, h)

    def _active_cancel_center(self) -> tuple[float, float, float]:
        px, py, _, ph = self._active_pill_rect()
        return (px + 22.0, py + ph / 2.0, 15.0)

    def _active_confirm_center(self) -> tuple[float, float, float]:
        px, py, pw, ph = self._active_pill_rect()
        return (px + pw - 22.0, py + ph / 2.0, 15.0)

    def _update_input_region(self) -> None:
        gdk_win = self.get_window()
        if gdk_win is None:
            return
        if self._state in ("recording", "processing"):
            rx, ry, rw, rh = self._active_pill_rect()
            region = cairo.Region(cairo.RectangleInt(rx, ry, rw, rh))
        elif self._hovered:
            mx, my, _, mh = self._hover_mic_rect()
            # Generous hit area around the two buttons so cursor movement feels effortless
            region = cairo.Region(cairo.RectangleInt(mx - 12, my - 10, 112 + 24, mh + 18))
        else:
            rx, ry, rw, rh = self._resting_rect()
            # Slightly taller hit strip (22px) around the 7px line so hovering is easy
            region = cairo.Region(cairo.RectangleInt(rx - 14, ry - 12, rw + 28, rh + 16))
        gdk_win.input_shape_combine_region(region, 0, 0)

    # ---------- Pointer interaction ----------

    def _on_enter(self, _w: Gtk.Widget, _ev: Gdk.EventCrossing) -> bool:
        if self._leave_timer is not None:
            GLib.source_remove(self._leave_timer)
            self._leave_timer = None
        if self._state == "idle" and not self._hovered:
            self._hovered = True
            self._update_input_region()
            self.queue_draw()
        return False

    def _on_leave(self, _w: Gtk.Widget, _ev: Gdk.EventCrossing) -> bool:
        if self._leave_timer is not None:
            GLib.source_remove(self._leave_timer)
        self._leave_timer = GLib.timeout_add(160, self._finish_leave)
        return False

    def _finish_leave(self) -> bool:
        self._leave_timer = None
        self._hovered = False
        self._hover_target = ""
        self._update_input_region()
        self.queue_draw()
        return False

    def _hit_test(self, x: float, y: float) -> str:
        if self._state in ("recording", "processing"):
            cx, cy, cr = self._active_cancel_center()
            if math.hypot(x - cx, y - cy) <= cr + 4:
                return "cancel"
            fx, fy, fr = self._active_confirm_center()
            if self._state == "recording" and math.hypot(x - fx, y - fy) <= fr + 4:
                return "confirm"
            return ""
        if self._hovered:
            mx, my, mw, mh = self._hover_mic_rect()
            if mx <= x <= mx + mw and my <= y <= my + mh:
                return "mic"
            nx, ny, nw, nh = self._hover_note_rect()
            if nx <= x <= nx + nw and ny <= y <= ny + nh:
                return "notetaker"
        return ""

    def _on_motion(self, _w: Gtk.Widget, ev: Gdk.EventMotion) -> bool:
        target = self._hit_test(ev.x, ev.y)
        if target != self._hover_target:
            self._hover_target = target
            gdk_win = self.get_window()
            if gdk_win is not None:
                cursor_name = "pointer" if target else "default"
                gdk_win.set_cursor(Gdk.Cursor.new_from_name(gdk_win.get_display(), cursor_name))
            self.queue_draw()
        return False

    def _on_click(self, _w: Gtk.Widget, ev: Gdk.EventButton) -> bool:
        if ev.button != 1:
            return False
        target = self._hit_test(ev.x, ev.y)
        if target == "mic":
            self._hovered = False
            _emit("start")
        elif target == "notetaker":
            self._hovered = False
            self._update_input_region()
            self.queue_draw()
            _emit("open_notetaker")
        elif target == "cancel":
            _emit("cancel")
        elif target == "confirm":
            _emit("stop")
        return True

    # ---------- State updates from daemon ----------

    def apply_config(self, show_always: bool, hotkey: str) -> None:
        self._show_always = show_always
        if hotkey:
            self._hotkey = hotkey
        self._sync_visibility()

    def apply_state(self, state: str, detail: str, hotkey: str) -> None:
        self._state = state
        self._detail = detail
        if hotkey:
            self._hotkey = hotkey
        if state != "idle":
            self._hovered = False
        if state == "recording":
            self._levels = deque([0.12] * 9, maxlen=9)
        self._sync_visibility()

    def push_level(self, level: float) -> None:
        self._levels.append(max(0.08, min(1.0, level)))

    def _sync_visibility(self) -> None:
        should_show = self._state in ("recording", "processing") or self._show_always
        if should_show:
            self._position_bottom_center()
            if not self.get_visible():
                self.show_all()
            self._update_input_region()
            self.queue_draw()
            if self._state in ("recording", "processing") and self._tick_id is None:
                self._tick_id = GLib.timeout_add(45, self._on_tick)
            elif self._state == "idle" and self._tick_id is not None:
                GLib.source_remove(self._tick_id)
                self._tick_id = None
        else:
            if self._tick_id is not None:
                GLib.source_remove(self._tick_id)
                self._tick_id = None
            if self.get_visible():
                self.hide()

    def _on_tick(self) -> bool:
        if self._state not in ("recording", "processing"):
            self._tick_id = None
            return False
        self._phase += 0.28
        self.queue_draw()
        return True

    # ---------- Cairo Rendering ----------

    def _on_draw(self, _widget: Gtk.Widget, cr: cairo.Context) -> bool:
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        if self._state in ("recording", "processing"):
            self._draw_active_pill(cr)
        elif self._hovered:
            self._draw_hover_bar(cr)
        elif self._show_always:
            self._draw_resting_bar(cr)
        return False

    def _draw_resting_bar(self, cr: cairo.Context) -> None:
        x, y, w, h = self._resting_rect()
        _rounded_rect(cr, x, y, w, h, h / 2.0)
        cr.set_source_rgba(0.05, 0.06, 0.08, 0.72)
        cr.fill_preserve()
        cr.set_line_width(1.0)
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.30)
        cr.stroke()

    def _draw_hover_bar(self, cr: cairo.Context) -> None:
        # 1. Top tooltip pill: "Dictate  Right Ctrl" (or "Notetaker" if hovering note btn)
        if self._hover_target == "notetaker":
            prefix, bold = "Notetaker ", "(Soon)"
        else:
            prefix, bold = "Dictate  ", self._hotkey

        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(12.5)
        ext1 = cr.text_extents(prefix)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(12.5)
        ext2 = cr.text_extents(bold)

        tw = ext1.x_advance + ext2.x_advance + 32
        th = 34
        tx = (self.WIN_W - tw) / 2.0
        ty = 16.0

        _rounded_rect(cr, tx, ty, tw, th, th / 2.0)
        cr.set_source_rgba(0.04, 0.04, 0.05, 0.95)
        cr.fill_preserve()
        cr.set_line_width(1.0)
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.16)
        cr.stroke()

        text_y = ty + (th + ext1.height) / 2.0 - 1.0
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(12.5)
        cr.set_source_rgba(0.86, 0.87, 0.90, 0.95)
        cr.move_to(tx + 16, text_y)
        cr.show_text(prefix)

        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(12.5)
        cr.set_source_rgba(1.0, 1.0, 1.0, 1.0)
        cr.move_to(tx + 16 + ext1.x_advance, text_y)
        cr.show_text(bold)

        # 2. Left Mic Pill Button
        mx, my, mw, mh = self._hover_mic_rect()
        _rounded_rect(cr, mx, my, mw, mh, mh / 2.0)
        if self._hover_target == "mic":
            cr.set_source_rgba(0.24, 0.25, 0.28, 0.96)
        else:
            cr.set_source_rgba(0.16, 0.17, 0.19, 0.94)
        cr.fill_preserve()
        cr.set_line_width(1.1)
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.24)
        cr.stroke()

        # Draw crisp white mic glyph centered in mic pill
        cx, cy = mx + mw / 2.0, my + mh / 2.0
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.96)
        _rounded_rect(cr, cx - 3.2, cy - 8.5, 6.4, 11.0, 3.2)
        cr.fill()
        cr.set_line_width(1.8)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.arc(cx, cy - 0.5, 6.4, 0.15 * math.pi, 0.85 * math.pi)
        cr.stroke()
        cr.move_to(cx, cy + 5.8)
        cr.line_to(cx, cy + 9.0)
        cr.stroke()

        # 3. Right Circular Notetaker Button
        nx, ny, nw, nh = self._hover_note_rect()
        ncx, ncy = nx + nw / 2.0, ny + nh / 2.0
        cr.arc(ncx, ncy, nw / 2.0, 0, 2 * math.pi)
        if self._hover_target == "notetaker":
            cr.set_source_rgba(0.18, 0.19, 0.22, 0.96)
        else:
            cr.set_source_rgba(0.05, 0.05, 0.06, 0.94)
        cr.fill_preserve()
        cr.set_line_width(1.1)
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.24)
        cr.stroke()

        # Concentric target/record glyph matching Wispr Flow Notetaker icon
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.95)
        cr.set_line_width(1.7)
        cr.arc(ncx, ncy, 7.5, 0, 2 * math.pi)
        cr.stroke()
        cr.arc(ncx, ncy, 3.6, 0, 2 * math.pi)
        cr.fill()

    def _draw_active_pill(self, cr: cairo.Context) -> None:
        px, py, pw, ph = self._active_pill_rect()
        _rounded_rect(cr, px, py, pw, ph, ph / 2.0)
        cr.set_source_rgba(0.04, 0.04, 0.05, 0.96)
        cr.fill_preserve()
        cr.set_line_width(1.2)
        if self._state == "processing":
            cr.set_source_rgba(0.22, 0.64, 0.61, 0.65)
        else:
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.24)
        cr.stroke()

        # Left circular [X] cancel button
        cx, cy, rad = self._active_cancel_center()
        cr.arc(cx, cy, rad, 0, 2 * math.pi)
        if self._hover_target == "cancel":
            cr.set_source_rgba(0.36, 0.35, 0.34, 0.98)
        else:
            cr.set_source_rgba(0.26, 0.25, 0.24, 0.95)
        cr.fill()

        cr.set_source_rgba(1.0, 1.0, 1.0, 0.95)
        cr.set_line_width(2.0)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        d = 4.6
        cr.move_to(cx - d, cy - d)
        cr.line_to(cx + d, cy + d)
        cr.move_to(cx + d, cy - d)
        cr.line_to(cx - d, cy + d)
        cr.stroke()

        # Center 9-dot / bar waveform
        n_bars = 9
        bar_w = 3.2
        gap = 5.4
        total_w = n_bars * bar_w + (n_bars - 1) * gap
        start_x = px + (pw - total_w) / 2.0
        levels = list(self._levels)
        for i in range(n_bars):
            bx = start_x + i * (bar_w + gap)
            if self._state == "recording":
                lvl = levels[i]
                # Taper edges slightly for a graceful capsule silhouette
                edge = 1.0 - abs(i - 4) * 0.11
                bh = max(3.4, min(20.0, lvl * 22.0 * edge + 2.5))
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.95)
            else:
                # Smooth travelling wave while transcribing / polishing
                wave = 0.5 + 0.5 * math.sin(self._phase * 1.6 - i * 0.55)
                bh = 3.4 + wave * 9.5
                cr.set_source_rgba(0.45, 0.86, 0.82, 0.55 + 0.45 * wave)
            by = py + (ph - bh) / 2.0
            _rounded_rect(cr, bx, by, bar_w, bh, bar_w / 2.0)
            cr.fill()

        # Right bright white circular [✓] confirm button
        fx, fy, frad = self._active_confirm_center()
        cr.arc(fx, fy, frad, 0, 2 * math.pi)
        if self._state == "processing":
            cr.set_source_rgba(0.20, 0.22, 0.25, 0.95)
        elif self._hover_target == "confirm":
            cr.set_source_rgba(0.92, 0.92, 0.92, 1.0)
        else:
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.98)
        cr.fill()

        if self._state == "recording":
            cr.set_source_rgba(0.06, 0.06, 0.08, 0.98)
            cr.set_line_width(2.2)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            cr.move_to(fx - 5.2, fy + 0.2)
            cr.line_to(fx - 1.4, fy + 4.0)
            cr.line_to(fx + 5.6, fy - 3.8)
            cr.stroke()
        else:
            # Small subtle spinner arc while polishing
            cr.set_source_rgba(0.45, 0.86, 0.82, 0.95)
            cr.set_line_width(2.0)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.arc(fx, fy, 6.2, self._phase * 2.0, self._phase * 2.0 + 3.8)
            cr.stroke()


def _stdin_reader(win: FloatingBarWindow) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            mtype = msg.get("type")
            if mtype == "level":
                GLib.idle_add(win.push_level, float(msg.get("level", 0.0)))
            elif mtype == "state":
                GLib.idle_add(
                    win.apply_state,
                    str(msg.get("state", "idle")),
                    str(msg.get("detail", "")),
                    str(msg.get("hotkey", "")),
                )
            elif mtype == "config":
                GLib.idle_add(
                    win.apply_config,
                    bool(msg.get("show_always", True)),
                    str(msg.get("hotkey", "")),
                )
        except Exception:
            pass
    # Parent pipe closed — exit cleanly
    GLib.idle_add(Gtk.main_quit)


def main() -> int:
    win = FloatingBarWindow()
    win.connect("destroy", Gtk.main_quit)
    threading.Thread(target=_stdin_reader, args=(win,), daemon=True).start()
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
