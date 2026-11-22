# VoxBox

A fast, 100% offline **Wispr Flow–style** voice dictation app purpose-built for **Linux (Ubuntu GNOME Wayland) + NVIDIA CUDA + local Ollama**.

## Features
- **True global Hold-to-Talk on Wayland** — kernel-level `evdev` listener (no GNOME shortcut hacks, ignores key repeats, auto-recovers on keyboard hotplug/wake, `Esc` to cancel).
- **Bottom-center Floating Bar** — ultra-minimal translucent resting line with border → expands on hover to show your hotkey tooltip + Mic & Notetaker buttons → expands during dictation into `[✕ | live 9-bar waveform | ✓]`.
- **CUDA-accelerated Whisper (`large-v3-turbo`)** — stays warm in VRAM (~150 ms transcription for 10s of speech).
- **Always-on local Ollama AI cleanup** — removes filler words, fixes self-corrections and punctuation, respects your personal **Dictionary**, expands **Snippets**, applies your **Style** and optional **Transforms** — 100% offline.
- **Universal Wayland pasting** — `wl-copy` (both Clipboard & Primary) + `ydotool` (`Shift+Insert` works in both GUI apps and terminals).
- **Native Desktop Hub (Dark mode default + Light toggle)** — Dictation history, Insights (WPM, AI fixes, activity streak heatmap), Dictionary, Snippets, Style, Transforms, Scratchpad, and live Settings.
- **Planned (Phase 2): Meeting Notetaker** — dual-stream audio capture (mic + PipeWire system speaker monitor) for live call transcripts and local Ollama meeting summaries.

## Requirements (Ubuntu 26.04 / Debian)
```bash
sudo apt install -y \
  wl-clipboard ydotool python3-evdev python3-gi python3-gi-cairo \
  python3-numpy python3-requests gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
  gir1.2-ayatanaappindicator3-0.1 cmake ninja-build
sudo usermod -aG input "$USER"
# Log out and back in so the input group & ydotool.service take effect.
```

## Setup
```bash
./scripts/build-whisper.sh   # Compiles CUDA whisper-server & downloads large-v3-turbo-q8_0
./install.sh                 # Installs CLI, desktop launcher, and systemd user service
systemctl --user start voxbox.service
```

## Usage
- **Hold `Right Ctrl`** anywhere → speak → release to transcribe, clean, and paste.
- Click the **VoxBox** icon in your top bar (or launch **VoxBox** from Ubuntu Apps) to open the Desktop Hub.
- Config lives at `~/.config/voxbox/config.toml`; local database lives at `~/.local/share/voxbox/voxbox.db`.
