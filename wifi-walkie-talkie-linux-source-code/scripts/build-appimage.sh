#!/bin/bash
# Build a self-contained AppImage with a launcher we fully control.
#
# electron-builder's built-in AppImage target always injects a first-run EULA
# dialog (zenity/kdialog) whose "Disagree" button exits silently, and an AppRun
# whose $APPDIR detection breaks when arguments are present. We therefore build
# the unpacked tree with electron-builder and assemble the AppDir ourselves:
#
#   electron-builder --linux dir   ->  dist/linux-unpacked
#   + AppRun / .desktop / icons
#   + mksquashfs                  ->  squashfs image
#   + appimage runtime stub       ->  final .AppImage
#
# Everything (Electron, Chromium, Node, the app, its icons and libraries) is
# packed inside the single file; the only host requirements are glibc >= 2.25 and
# the standard desktop stack (GTK3/NSS/X11), which every Linux desktop provides.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$ROOT/.buildtools/node/bin:$PATH"
export ELECTRON_CACHE="$ROOT/.buildtools/electron-cache"

APP_NAME="WiFi-Walkie-Talkie"
EXE_NAME="wifi-walkie-talkie-linux"
DESKTOP_NAME="$EXE_NAME.desktop"
ICON_NAME="$EXE_NAME.png"
VERSION="$(node -p "require('./package.json').version")"
OUT="dist/${APP_NAME}-${VERSION}-x86_64.AppImage"
STAGE="dist/.appimage-stage"

command -v mksquashfs >/dev/null || { echo "ERROR: mksquashfs not found (install squashfs-tools)"; exit 1; }

# ---------------------------------------------------------------------------
# 1. unpacked application tree
# ---------------------------------------------------------------------------
echo "==> Building unpacked application"
rm -rf dist/linux-unpacked
npx electron-builder --linux dir --publish never

# ---------------------------------------------------------------------------
# 2. AppDir layout
# ---------------------------------------------------------------------------
echo "==> Staging AppDir"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a dist/linux-unpacked/. "$STAGE/"

ICON_SRC="build/icons/1024x1024.png"
[ -f "$ICON_SRC" ] || { echo "ERROR: missing $ICON_SRC"; exit 1; }

# hicolor icon set + top-level symlink, so every desktop finds an icon.
for size in 16 24 32 48 64 128 256 512 1024; do
  mkdir -p "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
  cp "$ICON_SRC" "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps/$ICON_NAME"
done
ln -sf "usr/share/icons/hicolor/1024x1024/apps/$ICON_NAME" "$STAGE/$ICON_NAME"

# electron-builder bundles a few optional libs into usr/lib; make sure the
# directory exists so AppRun's LD_LIBRARY_PATH is meaningful.
mkdir -p "$STAGE/usr/lib"
cp -a "$ROOT/.buildtools/electron-builder-cache/appimage/appimage-12.0.1/lib/x64/." "$STAGE/usr/lib/" 2>/dev/null || true

cp "$ROOT/LICENSE" "$STAGE/LICENSE"

# ---------------------------------------------------------------------------
# 3. Launcher
# ---------------------------------------------------------------------------
# Deliberately simple and robust: no EULA prompt, correct APPDIR even when
# arguments are passed, and --no-sandbox applied consistently for both
# double-click and terminal launches.
cat > "$STAGE/AppRun" <<APPRUN
#!/bin/bash
# AppRun - launcher for ${APP_NAME}
set -u

# Resolve the AppDir without relying on \$1 (the generated AppRun used "\$path/\$1",
# which broke whenever arguments were passed).
SELF="\${BASH_SOURCE[0]:-\$0}"
APPDIR="\$(cd "\$(dirname "\$(readlink -f "\$SELF")")" && pwd)"
export APPDIR

export PATH="\$APPDIR:\$APPDIR/usr/bin:\$PATH"
export LD_LIBRARY_PATH="\$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="\$APPDIR/usr/share:\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

BIN="\$APPDIR/${EXE_NAME}"

if [ ! -x "\$BIN" ]; then
  echo "${APP_NAME}: cannot find the application binary at \$BIN" >&2
  exit 1
fi

# Chromium's setuid sandbox cannot work inside a read-only squashfs/FUSE mount,
# so the launcher always supplies --no-sandbox unless the caller already did.
have_no_sandbox=0
for a in "\$@"; do
  [ "\$a" = "--no-sandbox" ] && have_no_sandbox=1
done

if [ "\$have_no_sandbox" -eq 1 ]; then
  exec "\$BIN" "\$@"
else
  exec "\$BIN" --no-sandbox "\$@"
fi
APPRUN
chmod +x "$STAGE/AppRun"

# ---------------------------------------------------------------------------
# 4. Desktop entry
# ---------------------------------------------------------------------------
cat > "$STAGE/$DESKTOP_NAME" <<DESKTOP
[Desktop Entry]
Name=${APP_NAME}
GenericName=WiFi Walkie-Talkie
Comment=Talk, call and share files instantly with anyone on your local Wi-Fi. Zero internet, zero cloud, 100% private peer-to-peer.
Exec=AppRun %U
Icon=${EXE_NAME}
Terminal=false
Type=Application
Categories=Network;AudioVideo;Communication;
Keywords=walkie-talkie;p2p;mesh;offline;radio;lan;chat;
StartupWMClass=${APP_NAME}
X-AppImage-Name=${EXE_NAME}
X-AppImage-Version=${VERSION}
MimeType=x-scheme-handler/walkietalkie;
DESKTOP

# ---------------------------------------------------------------------------
# 5. Squashfs + runtime
# ---------------------------------------------------------------------------
# The runtime stub is the first thing a user executes, so its dependencies decide
# which distros can run the file at all.
#
# electron-builder ships appimage-12.0.1 (2019), which hard-requires the host to
# provide libfuse.so.2 and prints a cryptic dlopen error on distros that only ship
# FUSE 3 (Ubuntu >= 24.04, Debian >= 13, Arch...). The modern type-2 runtime from
# AppImage/type2-runtime is statically linked and embeds squashfuse, so it needs
# neither libfuse nor any shared library. We prefer it and download it once.
RUNTIME_DIR="$ROOT/.buildtools/appimage-runtime"
RUNTIME="$RUNTIME_DIR/runtime-x86_64"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64"

if [ ! -f "$RUNTIME" ]; then
  echo "==> Downloading modern static AppImage runtime (FUSE3 built in)"
  mkdir -p "$RUNTIME_DIR"
  if ! curl -fsSL -o "$RUNTIME.tmp" "$RUNTIME_URL"; then
    echo "    download failed, falling back to the electron-builder runtime"
    rm -f "$RUNTIME.tmp"
  else
    mv "$RUNTIME.tmp" "$RUNTIME"
  fi
fi

if [ ! -f "$RUNTIME" ]; then
  RUNTIME="${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}/appimage/appimage-12.0.1/runtime-x64"
  [ -f "$RUNTIME" ] || RUNTIME="$ROOT/.buildtools/electron-builder-cache/appimage/appimage-12.0.1/runtime-x64"
  [ -f "$RUNTIME" ] || { echo "ERROR: AppImage runtime stub not found"; exit 1; }
  echo "    NOTE: using legacy runtime; users may need libfuse2 installed"
else
  chmod +x "$RUNTIME"
fi

echo "==> Building squashfs image"
rm -f "$OUT" dist/.tmp.sfs
mksquashfs "$STAGE" dist/.tmp.sfs \
  -root-owned -noappend -no-progress -quiet \
  -comp gzip -b 1M -Xcompression-level 9 \
  -mkfs-time 0 -all-time 0 -processors "$(nproc)"

echo "==> Assembling AppImage"
cat "$RUNTIME" dist/.tmp.sfs > "$OUT"
chmod +x "$OUT"
rm -rf "$STAGE" dist/.tmp.sfs

echo
echo "==> Built $OUT"
ls -lh "$OUT"
echo "    glibc floor and contents can be verified with:"
echo "      cd dist && ./$(basename "$OUT") --appimage-extract"