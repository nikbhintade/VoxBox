#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$BIN_DIR" "$APP_DIR" "$SYSTEMD_DIR" "$PROJECT_DIR/bin"

chmod +x "$PROJECT_DIR/voxbox_main.py" "$PROJECT_DIR/voxbox_bar.py" "$PROJECT_DIR/voxbox_hub.py" "$PROJECT_DIR/scripts/build-whisper.sh"

# Install CLI launcher
cat > "$BIN_DIR/voxbox" <<EOF
#!/usr/bin/env bash
exec python3 "$PROJECT_DIR/voxbox_main.py" "\$@"
EOF
chmod +x "$BIN_DIR/voxbox"

# Initialize default config (~/.config/voxbox/config.toml)
python3 "$PROJECT_DIR/voxbox_main.py" --init-config

# Install desktop app launcher (opens VoxBox Hub window)
cat > "$APP_DIR/voxbox.desktop" <<EOF
[Desktop Entry]
Name=VoxBox
Comment=Offline GPU Hold-to-Talk AI Voice Dictation
Exec=$BIN_DIR/voxbox --open
Icon=audio-input-microphone
Terminal=false
Type=Application
Categories=Utility;Audio;
StartupNotify=false
EOF

# Install systemd user daemon service
cat > "$SYSTEMD_DIR/voxbox.service" <<EOF
[Unit]
Description=VoxBox - Offline GPU Hold-to-Talk AI Voice Dictation
After=graphical-session.target ydotool.service

[Service]
Type=simple
ExecStart=$BIN_DIR/voxbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable voxbox.service

echo "VoxBox installed:"
echo "  CLI:      $BIN_DIR/voxbox"
echo "  Launcher: $APP_DIR/voxbox.desktop"
echo "  Service:  $SYSTEMD_DIR/voxbox.service"
echo "  Config:   $HOME/.config/voxbox/config.toml"
