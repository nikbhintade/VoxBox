# Changelog

All notable changes to **VoxBox** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-22

### Added
- **Global Hold-to-Talk on Linux Wayland** via `evdev` (`/dev/input/event*`) with automatic keyboard hotplug/wake recovery, short-tap filtering, and `Esc` to cancel.
- **Native PipeWire Audio Capture** (`pw-record`) with real-time RMS metering, silence gating, subtle start/stop/cancel chimes, and optional system-audio muting while dictating.
- **Local Whisper Speech Recognition (`whisper-server`)** with in-app **Speech Models** manager (7 curated Whisper GGML models from Tiny to Large v3 Turbo, streaming download progress, cancel, hot-swap, and delete — user selects their own model on first run, with no automatic downloads).
- **Multi-Provider AI Cleanup** with local VRAM-tiered **Ollama** catalog + in-app streaming pull, plus native support for **Gemini**, **Claude**, **OpenAI**, and **OpenAI-compatible** endpoints (Groq, OpenRouter, DeepSeek, Together AI, Cerebras, LM Studio) and live connection testing.
- **Universal Wayland Pasting** via `wl-copy` (both Clipboard and Primary selection) + `ydotool` (`Shift+Insert`, `Ctrl+V`, `Ctrl+Shift+V`, direct typing, or clipboard-only).
- **Bottom-Center Floating Bar** (XWayland) with silky 60fps animations: thin translucent resting bar, hover controls with hotkey tooltip, and active recording/processing capsule (`[✕ | live 9-bar waveform | ✓]`).
- **VoxBox Desktop Hub** (native GTK3 + WebKit2GTK) with Dark default + Light appearance, Dictation feed with inline editing & `.txt` export, master-detail Scratchpad with `.md` export, Dictionary, Snippets, Style presets, Transforms, Insights analytics & streak heatmap, Settings sheet, and Phase 2 Notetaker roadmap tab.
- **Automated Linux Releases** (`.deb`, portable `.tar.gz`, and `SHA256SUMS.txt`) via GitHub Actions, dual-licensed under **MIT OR Apache-2.0**.
