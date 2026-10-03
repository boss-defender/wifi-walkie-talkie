#!/usr/bin/env python3
"""
Drive the running application over the Chrome DevTools Protocol and capture
each tab. X11 synthetic clicks are unreliable against Chromium, so tab switches
are issued as real DOM clicks over CDP instead.

Requires the app to be running with --remote-debugging-port:

    wine dist/win-unpacked/wifi-walkie-talkie.exe --remote-debugging-port=9333

Usage: python3 scripts/ui-check.py [port] [output-dir]
"""
import base64
import json
import os
import struct
import sys
import time
import urllib.request

DEFAULT_PORT = 9333
TABS = ("radio", "hub", "chats", "settings")


# --------------------------------------------------------------------------
# Minimal CDP client (no third-party dependencies)
# --------------------------------------------------------------------------

def find_page(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=8) as r:
        for target in json.load(r):
            if target.get("type") == "page" and "index.html" in target.get("url", ""):
                return target
    return None


def connect(ws_url):
    u = ws_url.split("://", 1)[1]
    hostport, _, path = u.partition("/")
    host, _, port = hostport.partition(":")
    import socket
    sock = socket.create_connection((host, int(port or 80)), timeout=25)

    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)
    if b"101" not in buf.split(b"\r\n")[0]:
        raise RuntimeError(f"websocket handshake failed: {buf[:200]!r}")

    counter = [0]

    def call(method, params=None):
        counter[0] += 1
        payload = json.dumps({"id": counter[0], "method": method, "params": params or {}}).encode()
        header = bytearray([0x81])
        n = len(payload)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        header += bytes(payload[i] ^ mask[i % 4] for i in range(n))
        sock.sendall(bytes(header))

        while True:
            h = sock.recv(2)
            if not h:
                raise RuntimeError("connection closed")
            ln = h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", sock.recv(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", sock.recv(8))[0]
            data = b""
            while len(data) < ln:
                data += sock.recv(ln - len(data))
            msg = json.loads(data.decode())
            if msg.get("id") == counter[0]:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    return call


def evaluate(call, expression):
    r = call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")


def screenshot(call, path):
    data = call("Page.captureScreenshot", {"format": "png"})["data"]
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(data))
    return path


# --------------------------------------------------------------------------

CLICK_TAB = """
(() => {
  const tab = document.querySelector('.tab[data-tab="%s"]');
  if (!tab) return 'missing tab %s';
  tab.click();
  return 'ok';
})()
"""

# Assertions that must hold on every rendered tab. A failing one means the tab
# is visually broken even if it "loaded", so they are treated as failures rather
# than reported silently.
AUDIT = """
(() => {
  const panel = document.querySelector('.panel.active');
  const problems = [];

  const icons = [...document.querySelectorAll('[data-icon]')];
  const empty = icons.filter((e) => !e.querySelector('svg'));
  if (empty.length) {
    const names = empty.map((e) => e.getAttribute('data-icon')).join(', ');
    problems.push(`${empty.length} icon placeholder(s) never hydrated: ${names}`);
  }

  // An icon that is actually on screen but has no layout box means the glyph
  // exists yet cannot be seen. Anything inside a hidden container (inactive
  // panel, closed call overlay, dismissed banner, `.hidden` element) is
  // legitimately size-less, so it is skipped — its tab state is checked when
  // that container is opened.
  const isVisible = (e) => {
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      if (n.classList && n.classList.contains('hidden')) return false;
      if (n.classList && n.classList.contains('panel') && !n.classList.contains('active')) return false;
      const d = getComputedStyle(n).display;
      if (d === 'none' || d === 'contents') return false;
    }
    return true;
  };
  const collapsed = [...document.querySelectorAll('svg.ico')]
    .filter((e) => isVisible(e))
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width < 6 || r.height < 6;
    });
  if (collapsed.length) problems.push(`${collapsed.length} visible icon(s) rendered with no size`);

  const dupes = {};
  for (const e of document.querySelectorAll('[id]')) dupes[e.id] = (dupes[e.id] || 0) + 1;
  const dup = Object.entries(dupes).filter(([, c]) => c > 1).map(([k]) => k);
  if (dup.length) problems.push(`duplicate ids: ${dup.join(', ')}`);

  // Text overflowing its container is the most common visual defect.
  const overflow = [...document.querySelectorAll('.card, .msg, .peer-row, .chat-head')]
    .filter((e) => e.scrollWidth > e.clientWidth + 2)
    .map((e) => `${e.className.split(' ')[0]} ${e.scrollWidth}>${e.clientWidth}`);
  if (overflow.length) problems.push(`overflowing: ${overflow.join('; ')}`);

  // Buttons must be big enough to hit reliably with a mouse. The star toggle is
  // deliberately tiny by design (it sits on every message bubble), so it is
  // exempt by name and checked against its own, smaller floor instead.
  const MIN = 24;
  const MIN_EXEMPT = { 'star-btn': 18 };
  const inActivePanel = (e) => {
    const p = e.closest('.panel');
    return p && p.classList.contains('active');
  };
  const small = [...document.querySelectorAll('button')]
    .filter(isVisible)
    .filter(inActivePanel)
    .map((b) => ({ b, r: b.getBoundingClientRect() }))
    .filter(({ b, r }) => {
      const floor = MIN_EXEMPT[b.className.split(' ')[0]] || MIN;
      return r.width < floor || r.height < floor;
    })
    .map(({ b, r }) => `${b.id || b.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
  if (small.length) problems.push(`undersized buttons: ${small.join('; ')}`);

  // Every icon-only button needs an accessible name for screen readers.
  const unnamed = [...document.querySelectorAll('button')]
    .filter(isVisible)
    .filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.title)
    .map((b) => b.id || b.className);
  if (unnamed.length) problems.push(`icon-only buttons without a label: ${unnamed.join(', ')}`);

  // The call overlay and the incoming-call banner are hidden on this tab, so
  // their controls would otherwise never be inspected. Reveal them for the
  // duration of the audit and confirm they are sound too.
  const revealed = [];
  for (const id of ['callOverlay', 'incomingBanner']) {
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('hidden')) continue;
    el.classList.remove('hidden');
    revealed.push(id);
    const bad = [...el.querySelectorAll('svg.ico')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width < 6 || r.height < 6; })
      .length;
    if (bad) problems.push(`${id}: ${bad} icon(s) rendered with no size`);
    const noLabel = [...el.querySelectorAll('button')]
      .filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.title)
      .map((b) => b.id);
    if (noLabel.length) problems.push(`${id}: unlabelled button(s) ${noLabel.join(', ')}`);
  }
  for (const id of revealed) document.getElementById(id).classList.add('hidden');

  return {
    panel: panel ? panel.id : null,
    icons: document.querySelectorAll('svg.ico').length,
    buttons: document.querySelectorAll('.panel.active button').length,
    problems,
  };
})()
"""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    outdir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/opencode"

    target = find_page(port)
    if not target:
        print(f"No application page on port {port}.")
        print("Start it with:  --remote-debugging-port=%d" % port)
        return 2

    call = connect(target["webSocketDebuggerUrl"])
    call("Page.enable")
    call("Runtime.enable")

    failures = 0
    print(f"\n=== UI check: {target['title']} ===\n")

    for tab in TABS:
        result = evaluate(call, CLICK_TAB % (tab, tab))
        if result != "ok":
            print(f"  FAIL  {tab}: {result}")
            failures += 1
            continue
        time.sleep(1.2)

        audit = evaluate(call, AUDIT) or {}
        problems = audit.get("problems", [])
        if problems:
            failures += 1
            print(f"  FAIL  {tab}:")
            for p in problems:
                print(f"          - {p}")
        else:
            print(f"  PASS  {tab}: {audit.get('icons')} icons, {audit.get('buttons')} buttons, no layout problems")

        path = os.path.join(outdir, f"tab-{tab}.png")
        try:
            screenshot(call, path)
            print(f"        saved {path}")
        except Exception as exc:  # screenshotting must never fail the audit
            print(f"        note: screenshot failed ({exc})")

    # Leave the app on its default tab.
    evaluate(call, CLICK_TAB % ("chats", "chats"))

    print(f"\n=== {'UI OK' if failures == 0 else f'{failures} TAB(S) WITH PROBLEMS'} ===\n")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())