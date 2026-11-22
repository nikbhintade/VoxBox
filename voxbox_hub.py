#!/usr/bin/env python3
"""VoxBox Desktop Hub Window (Native GTK3 + WebKit2GTK)."""

from __future__ import annotations

import os
import signal
import sys

# Avoid occasional NVIDIA + WebKitGTK DMA-BUF blank frames on Linux Wayland.
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")

from gi.repository import Gdk, Gtk, WebKit2


class VoxBoxHubWindow(Gtk.Window):
    def __init__(self, url: str) -> None:
        super().__init__(title="VoxBox")
        self.set_default_size(1160, 760)
        self.set_size_request(860, 580)
        self.set_position(Gtk.WindowPosition.CENTER)

        # Dark background color to prevent any white flash before CSS loads
        rgba = Gdk.RGBA()
        rgba.parse("#0e0f12")

        webview = WebKit2.WebView()
        webview.set_background_color(rgba)
        settings = webview.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_smooth_scrolling(True)

        # Open external links in the user's browser instead of inside the Hub
        webview.connect("decide-policy", self._on_decide_policy)
        webview.load_uri(url)

        self.add(webview)
        self.connect("destroy", Gtk.main_quit)

    def _on_decide_policy(self, _webview: WebKit2.WebView, decision: WebKit2.PolicyDecision, dtype: WebKit2.PolicyDecisionType) -> bool:
        if dtype == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri and not uri.startswith("http://127.0.0.1"):
                Gtk.show_uri_on_window(self, uri, Gdk.CURRENT_TIME)
                decision.ignore()
                return True
        return False


def main() -> int:
    signal.signal(signal.SIGINT, lambda *_: Gtk.main_quit())
    signal.signal(signal.SIGTERM, lambda *_: Gtk.main_quit())
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8179/"
    win = VoxBoxHubWindow(url)
    win.show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
