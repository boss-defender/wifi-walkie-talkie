#!/bin/bash
# Build the single self-contained Windows .exe.
#
#   npm run dist   ->  dist/WiFi-Walkie-Talkie-1.0.0-x64-portable.exe
#
# The `portable` target is used rather than an NSIS installer on purpose: the
# result is ONE file that a user double-clicks and runs. Nothing is installed,
# nothing is registered, nothing is left behind on disk, and the app can be
# deleted by deleting the .exe.
#
# How a portable build works: the .exe is an NSIS stub with the whole unpacked
# application appended as a 7z archive. On launch it unpacks itself into a
# per-run folder under %TEMP%, runs, and cleans up on exit. The user's data is
# NOT affected — `app.getPath('userData')` still resolves to
# %APPDATA%\WiFi Walkie-Talkie, so messages, preferences and received files
# survive every run.
#
# Building this on Linux/macOS is fully supported: electron-builder downloads the
# Windows Electron distribution, edits the executable's icon/version resources
# with the pure-JS `resedit` library and runs NSIS' own makensis binary. No Wine
# and no Windows machine are required.
#
# To add a code signature later, set CSC_LINK (path to the .pfx) and CSC_KEY_PASSWORD
# in the environment and re-run; nothing else has to change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$ROOT/.buildtools/node/bin:$PATH"
export ELECTRON_CACHE="$ROOT/.buildtools/electron-cache"
# electron-builder caches the Windows Electron zip, NSIS and winCodeSign here.
export ELECTRON_BUILDER_CACHE="$ROOT/.buildtools/electron-builder-cache"

VERSION="$(node -p "require('./package.json').version")"
OUT="dist/WiFi-Walkie-Talkie-${VERSION}-x64-portable.exe"

command -v node >/dev/null || { echo "ERROR: node not found on PATH"; exit 1; }
[ -f build/icon.ico ] || { echo "ERROR: build/icon.ico is missing - run: npm run icons"; exit 1; }

echo "==> Verifying sources"
node scripts/renderer-check.js
node scripts/safety-check.js
for f in src/main/*.js; do node --check "$f"; done

echo
echo "==> Building the Windows portable executable"
rm -rf dist/win-unpacked "$OUT"
npx electron-builder --win portable --x64 --publish never

echo
if [ ! -f "$OUT" ]; then
  echo "ERROR: expected $OUT to exist"
  exit 1
fi

echo "==> Verifying the executable's Windows resources"
node scripts/verify-exe.js dist/win-unpacked/wifi-walkie-talkie.exe

echo "==> Built $OUT"
ls -lh "$OUT"
echo
echo "    Contents can be inspected without running it:"
echo "      7z l \"$OUT\""