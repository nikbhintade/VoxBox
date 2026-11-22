# VoxBox

A fast, offline-first voice dictation studio built for **Linux (Ubuntu GNOME Wayland)** with local Whisper speech recognition, multi-provider AI cleanup, a 60fps bottom-center floating bar, and a native desktop Hub.

## Features
- **True Global Hold-to-Talk on Wayland** — kernel-level `evdev` listener (works across all apps and terminals with zero compositor shortcut workarounds, hotplug/wake recovery, and `Esc` to cancel).
- **Bottom-Center Floating Bar** — thin translucent resting bar → smoothly expands on hover with your hotkey tooltip + Mic & Notetaker controls → fluid 60fps 9-bar waveform pill while recording and polishing.
- **In-App Speech Models Manager (User Choice)** — no model is downloaded automatically. On first launch, VoxBox prompts you to pick and download from 7 official Whisper GGML models (Tiny to Large v3 Turbo) based on your hardware, or drop any custom `.bin` model into `~/.local/share/voxbox/models/`.
- **Multi-Provider AI Cleanup** — local **Ollama** (with VRAM-tiered in-app model pulling) plus native **Gemini**, **Claude**, **OpenAI**, and **OpenAI-compatible** APIs (Groq, OpenRouter, DeepSeek, Together AI, Cerebras, LM Studio) — zero extra SDK dependencies.
- **Universal Wayland Pasting** — `wl-copy` (both Clipboard and Primary selection) + `ydotool` (`Shift+Insert`, `Ctrl+V`, `Ctrl+Shift+V`, direct typing, or clipboard-only).
- **Desktop Hub (Dark & Light)** — Dictation feed with inline editing & `.txt` export, master-detail Scratchpad with `.md` export, Dictionary, Snippets, Style presets, Transforms, Insights analytics & streak heatmap, and Settings.
- **Planned (Phase 2): Meeting Notetaker** — dual-stream PipeWire audio capture (mic + system speaker monitor) for offline call transcripts and summaries.

## Quick Install (GitHub Releases)

### Ubuntu / Debian (`.deb`)
Download `voxbox_<version>_amd64.deb` from the [Releases](https://github.com/nikbhintade/VoxBox/releases) page:
```bash
sudo apt install ./voxbox_0.1.0_amd64.deb
sudo usermod -aG input "$USER"
# Log out and log back in once so input group permissions take effect, then:
systemctl --user enable --now ydotool.service voxbox.service
```

### Other Linux Distros (`.tar.gz`)
Download `voxbox-<version>-linux-x86_64.tar.gz` from [Releases](https://github.com/nikbhintade/VoxBox/releases):
```bash
tar -xzf voxbox-0.1.0-linux-x86_64.tar.gz && cd voxbox-0.1.0-linux-x86_64
./install.sh
systemctl --user start voxbox.service
```

> **GPU Acceleration:** Release binaries ship with a portable **Vulkan + CPU** `whisper-server` (supports NVIDIA, AMD, Intel GPUs, and CPU fallback). NVIDIA users with CUDA Toolkit installed can optionally run `./scripts/build-whisper.sh` to compile a native CUDA binary.

## Building from Source
```bash
sudo apt install -y \
  wl-clipboard ydotool python3-evdev python3-gi python3-gi-cairo \
  python3-numpy python3-requests gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
  gir1.2-ayatanaappindicator3-0.1 cmake ninja-build libvulkan-dev glslc
./scripts/build-whisper.sh
./install.sh
systemctl --user start voxbox.service
```

## License
Dual-licensed under your choice of either:
- **MIT License** ([LICENSE-MIT](LICENSE-MIT))
- **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE))
