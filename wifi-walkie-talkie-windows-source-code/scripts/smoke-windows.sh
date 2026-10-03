#!/bin/bash
# End-to-end smoke test of the BUILT Windows .exe, on a Linux host via Wine.
#
# This is the only check that exercises the real shipped artifact rather than the
# source tree: it launches the portable .exe exactly as a user double-clicks it,
# confirms the P2P ports come up, and reads the persisted store back out of the
# simulated %APPDATA%.
#
# Requires: wine (>= 8), and a build produced by scripts/build-windows.sh.
# Usage:   bash scripts/smoke-windows.sh [path-to-exe]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXE="${1:-$ROOT/dist/WiFi-Walkie-Talkie-1.0.0-x64-portable.exe}"
export WINEPREFIX="${WINEPREFIX:-/tmp/walkie-wine}"
export WINEDEBUG="${WINEDEBUG:--all}"
USERDATA_REL='drive_c/users/'$USER'/AppData/Roaming/WiFi Walkie-Talkie'

PASS=0
FAIL=0
check() {
  if [ "$2" = "1" ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s%s\n' "$1" "${3:+ — $3}"
  fi
}

echo
echo "=== WiFi Walkie-Talkie :: Windows artifact smoke test ==="
echo
echo "  artifact : $(basename "$EXE")"
echo "  size     : $(du -h "$EXE" 2>/dev/null | cut -f1)"
echo "  wine     : $(wine --version 2>/dev/null | head -1)"
echo

[ -f "$EXE" ] || { echo "ERROR: $EXE not found — run scripts/build-windows.sh first"; exit 1; }

# Nothing may hold the P2P ports, or we would be probing a stale process.
for port in 8888 8887 8889 8890 9999; do
  if ss -tln "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    echo "ERROR: TCP $port is already in use. Close any running copy first."; exit 1
  fi
done

echo "--- preparing the wine prefix (first run takes a minute) ---"
rm -rf "$WINEPREFIX/walkie-smoke"
mkdir -p "$WINEPREFIX"
wineserver -k 2>/dev/null
wineboot -u >/dev/null 2>&1
echo "  prefix ready"
echo

echo "--- launching the .exe exactly as a user would ---"
RUN_DIR="$(mktemp -d)"
( cd "$RUN_DIR" && setsid timeout 180 wine "$EXE" >"$RUN_DIR/wine.log" 2>&1 & )
echo "  waiting for the window and the P2P services..."
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln "sport = :8888" 2>/dev/null | grep -q LISTEN; then break; fi
done

APP_PROC="$(pgrep -f 'wifi-walkie-talkie.exe' | head -1)"
[ -n "$APP_PROC" ] && check "application process is running" 1 || check "application process is running" 0 "no matching process"

# The main process is the one WITHOUT --type=, i.e. the one that owns the ports.
if [ -n "$APP_PROC" ]; then
  KILL_PIDS="$(pgrep -f 'wifi-walkie-talkie.exe')"
  trap 'kill $KILL_PIDS 2>/dev/null; wineserver -k 2>/dev/null' EXIT
fi

echo
echo "--- listening sockets ---"

# Count with grep -c, but never let the exit status of a "no match" leak into the
# script under `set -o pipefail`, which would abort the run on the first absent
# port instead of reporting it.
count_listen_tcp() { ss -tln "sport = :$1" 2>/dev/null | grep -c 'LISTEN' || true; }
count_unconn_udp() { ss -uln "sport = :$1" 2>/dev/null | grep -c 'UNCONN' || true; }

check "TCP 8888 (signalling / chat / files) is bound" \
  "$([ "$(count_listen_tcp 8888)" -ge 1 ] && echo 1 || echo 0)"

check_udp() {
  local port="$1" what="$2" count
  count="$(count_unconn_udp "$port")"
  check "$what is bound" "$([ "$count" -ge 1 ] && echo 1 || echo 0)" "$count socket(s)"
}
check_udp 8887 "UDP 8887 (broadcast signalling)"
check_udp 8889 "UDP 8889 (call video)"
check_udp 8890 "UDP 8890 (call audio)"
check_udp 9999 "UDP 9999 (walkie-talkie audio)"
check_udp 5353 "UDP 5353 (mDNS discovery)"

echo
echo "--- persisted user data ---"
UD="$WINEPREFIX/$USERDATA_REL"
check "userData directory created (%APPDATA%/WiFi Walkie-Talkie)" \
  "$([ -d "$UD" ] && echo 1 || echo 0)"
check "received-files directory created" "$([ -d "$UD/received" ] && echo 1 || echo 0)"
check "message store written (walkie-data.json)" "$([ -f "$UD/walkie-data.json" ] && echo 1 || echo 0)"

if [ -f "$UD/walkie-data.json" ]; then
  # The store must contain a self peer row with the machine's own address, which
  # proves the interface picker and the heartbeat both ran.
  if grep -q '"ipAddress":"' "$UD/walkie-data.json"; then
    check "store records this device's own address" 1
  else
    check "store records this device's own address" 0 "no ipAddress in the store"
  fi
  # The first-run firewall prompt must have been recorded so users are not
  # nagged on every launch.
  check "first-run firewall prompt was recorded (not repeated every launch)" \
    "$(grep -q '"firewall_prompted":true' "$UD/walkie-data.json" && echo 1 || echo 0)"
fi

echo
echo "--- the single .exe really is self-contained ---"
if command -v 7z >/dev/null 2>&1; then
  SZ=7z
elif [ -x "$ROOT/node_modules/7zip-bin/linux/x64/7za" ]; then
  SZ="$ROOT/node_modules/7zip-bin/linux/x64/7za"
else
  SZ=""
fi

if [ -n "$SZ" ]; then
  # A portable build is a TWO-layer NSIS archive: the outer stub holds the
  # uninstaller plugins plus one `app-64.7z`, and the application itself lives
  # inside that inner archive. Inspecting only the outer layer would check the
  # wrong files and report false failures, so the payload is unpacked first.
  XDIR="$(mktemp -d)"
  if "$SZ" e -y -o"$XDIR" "$EXE" '$PLUGINSDIR/app-64.7z' >/dev/null 2>&1 \
     && [ -f "$XDIR/app-64.7z" ]; then
    check "NSIS stub embeds the application payload" 1
    listing="$("$SZ" l "$XDIR/app-64.7z" 2>/dev/null)"
    for need in resources/app.asar wifi-walkie-talkie.exe resources.pak \
                locales/en-US.pak d3dcompiler_47.dll ffmpeg.dll libEGL.dll libGLESv2.dll; do
      if echo "$listing" | grep -q "$need"; then
        check "payload contains $need" 1
      else
        check "payload contains $need" 0 "not found in app-64.7z"
      fi
    done

    # The application must not have picked up any native module: every one of
    # them would have to be rebuilt and shipped for Windows separately.
    natives="$(echo "$listing" | grep -cE '\.node$' || true)"
    check "no native .node modules to rebuild (pure JS + system Chromium)" \
      "$([ "$natives" -eq 0 ] && echo 1 || echo 0)" "$natives found"

    # Locales other than en-US are dead weight in a single-file build.
    locales="$(echo "$listing" | grep -c 'locales/.*\.pak' || true)"
    check "only the en-US UI locale is shipped" \
      "$([ "$locales" -eq 1 ] && echo 1 || echo 0)" "$locales locale file(s)"
  else
    check "NSIS stub embeds the application payload" 0 "could not extract app-64.7z"
  fi
  rm -rf "$XDIR"
  check "nothing else is required beside the .exe" 1
else
  echo "  note  7-Zip not available, skipping archive inspection"
fi

echo
echo "--- clean shutdown ---"
if [ -n "${KILL_PIDS:-}" ]; then
  kill $KILL_PIDS 2>/dev/null
  sleep 6
fi
wineserver -k 2>/dev/null
sleep 3
STILL="$(pgrep -f 'wifi-walkie-talkie.exe' | wc -l)"
check "process exits cleanly" "$([ "$STILL" -eq 0 ] && echo 1 || echo 0)" "$STILL left"

rm -rf "$RUN_DIR"

echo
echo "=== $PASS passed, $FAIL failed ==="
echo
[ "$FAIL" -eq 0 ] || exit 1