#!/usr/bin/env bash
# Package VoxBox into a Debian/Ubuntu .deb, a portable Linux .tar.gz, and SHA256SUMS.txt.
set -euo pipefail

VERSION="${1:-0.1.0}"
VERSION="${VERSION#v}"
OUT_DIR="${2:-$(pwd)/dist}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="amd64"

if [ ! -x "$PROJECT_DIR/bin/whisper-server" ]; then
    echo "ERROR: $PROJECT_DIR/bin/whisper-server is missing or not executable." >&2
    echo "Build it first with ./scripts/build-whisper.sh" >&2
    exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUT_DIR"

# ---------- 1. Build Debian/Ubuntu .deb ----------
DEB_ROOT="$WORK_DIR/deb"
APP_ROOT="$DEB_ROOT/usr/lib/voxbox"
mkdir -p \
    "$DEB_ROOT/DEBIAN" \
    "$APP_ROOT/bin" \
    "$DEB_ROOT/usr/bin" \
    "$DEB_ROOT/usr/share/applications" \
    "$DEB_ROOT/usr/lib/systemd/user" \
    "$DEB_ROOT/usr/share/doc/voxbox"

cp -r "$PROJECT_DIR/voxbox" "$APP_ROOT/"
cp -r "$PROJECT_DIR/web" "$APP_ROOT/"
find "$APP_ROOT" -name "__pycache__" -type d -exec rm -rf {} +
cp "$PROJECT_DIR/voxbox_main.py" "$PROJECT_DIR/voxbox_bar.py" "$PROJECT_DIR/voxbox_hub.py" "$APP_ROOT/"
cp "$PROJECT_DIR/bin/whisper-server" "$APP_ROOT/bin/whisper-server"
chmod 755 "$APP_ROOT/voxbox_main.py" "$APP_ROOT/voxbox_bar.py" "$APP_ROOT/voxbox_hub.py" "$APP_ROOT/bin/whisper-server"

cp "$PROJECT_DIR/README.md" "$PROJECT_DIR/CHANGELOG.md" "$PROJECT_DIR/LICENSE-MIT" "$PROJECT_DIR/LICENSE-APACHE" "$DEB_ROOT/usr/share/doc/voxbox/"

cat > "$DEB_ROOT/usr/bin/voxbox" <<'EOF'
#!/usr/bin/env bash
exec python3 /usr/lib/voxbox/voxbox_main.py "$@"
EOF
chmod 755 "$DEB_ROOT/usr/bin/voxbox"

cat > "$DEB_ROOT/usr/share/applications/voxbox.desktop" <<'EOF'
[Desktop Entry]
Name=VoxBox
Comment=Offline GPU Hold-to-Talk AI Voice Dictation
Exec=/usr/bin/voxbox --open
Icon=audio-input-microphone
Terminal=false
Type=Application
Categories=Utility;Audio;
StartupNotify=false
EOF

cat > "$DEB_ROOT/usr/lib/systemd/user/voxbox.service" <<'EOF'
[Unit]
Description=VoxBox - Offline GPU Hold-to-Talk AI Voice Dictation
After=graphical-session.target ydotool.service

[Service]
Type=simple
ExecStart=/usr/bin/voxbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
EOF

cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: voxbox
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Maintainer: Nikhil Bhintade <29760727+nikbhintade@users.noreply.github.com>
Homepage: https://github.com/nikbhintade/VoxBox
Depends: python3 (>= 3.11), wl-clipboard, ydotool, python3-evdev, python3-gi, python3-gi-cairo, python3-numpy, python3-requests, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, gir1.2-ayatanaappindicator3-0.1, libvulkan1, pipewire-bin
Description: Offline GPU hold-to-talk AI voice dictation for Linux Wayland
 VoxBox pairs local Whisper speech recognition with customizable AI cleanup
 (local Ollama, Gemini, Claude, OpenAI, or any OpenAI-compatible API), global
 evdev hold-to-talk, a 60fps floating bar, and a native desktop Hub.
 Dual-licensed under MIT OR Apache-2.0.
EOF

cat > "$DEB_ROOT/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
echo ""
echo "VoxBox installed! Finish setup with:"
echo "  1. Allow evdev hotkeys & ydotool pasting:"
echo "       sudo usermod -aG input \$USER"
echo "     (Log out and log back in once for group membership to take effect.)"
echo "  2. Enable and start the background service:"
echo "       systemctl --user enable --now ydotool.service voxbox.service"
echo "  3. Launch VoxBox from your app menu to choose your Whisper speech model."
echo ""
EOF
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

DEB_FILE="$OUT_DIR/voxbox_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$DEB_ROOT" "$DEB_FILE"

# ---------- 2. Build Portable Linux .tar.gz ----------
TAR_NAME="voxbox-${VERSION}-linux-x86_64"
TAR_STAGE="$WORK_DIR/$TAR_NAME"
mkdir -p "$TAR_STAGE/bin" "$TAR_STAGE/scripts"

cp -r "$PROJECT_DIR/voxbox" "$TAR_STAGE/"
cp -r "$PROJECT_DIR/web" "$TAR_STAGE/"
find "$TAR_STAGE" -name "__pycache__" -type d -exec rm -rf {} +
cp "$PROJECT_DIR/voxbox_main.py" "$PROJECT_DIR/voxbox_bar.py" "$PROJECT_DIR/voxbox_hub.py" "$PROJECT_DIR/install.sh" "$TAR_STAGE/"
cp "$PROJECT_DIR/scripts/build-whisper.sh" "$TAR_STAGE/scripts/"
cp "$PROJECT_DIR/bin/whisper-server" "$TAR_STAGE/bin/whisper-server"
cp "$PROJECT_DIR/README.md" "$PROJECT_DIR/CHANGELOG.md" "$PROJECT_DIR/LICENSE-MIT" "$PROJECT_DIR/LICENSE-APACHE" "$TAR_STAGE/"
chmod 755 "$TAR_STAGE/voxbox_main.py" "$TAR_STAGE/voxbox_bar.py" "$TAR_STAGE/voxbox_hub.py" "$TAR_STAGE/install.sh" "$TAR_STAGE/scripts/build-whisper.sh" "$TAR_STAGE/bin/whisper-server"

TAR_FILE="$OUT_DIR/${TAR_NAME}.tar.gz"
tar -C "$WORK_DIR" -czf "$TAR_FILE" "$TAR_NAME"

# ---------- 3. Generate SHA256SUMS.txt ----------
(
    cd "$OUT_DIR"
    sha256sum "$(basename "$DEB_FILE")" "$(basename "$TAR_FILE")" > SHA256SUMS.txt
)

echo "Built release artifacts in $OUT_DIR:"
ls -lh "$DEB_FILE" "$TAR_FILE" "$OUT_DIR/SHA256SUMS.txt"
