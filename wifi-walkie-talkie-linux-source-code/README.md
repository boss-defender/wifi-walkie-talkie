# 📻 WiFi Walkie-Talkie — Linux Desktop Edition

> **Talk, call, and share files instantly with anyone on your local Wi‑Fi — zero internet, zero cloud, 100% private.**

A self-contained **AppImage** port of the Android WiFi Walkie-Talkie. It is protocol-compatible
with the Android app: an Android phone and a Linux desktop on the same Wi‑Fi discover each
other and can talk, chat, send files and call each other.

```
./WiFi-Walkie-Talkie-1.0.0-x86_64.AppImage
```

That is the whole installation. Double-click it, or run it from a terminal. Everything —
Electron, Chromium, Node.js, the app and its libraries — is packed inside the single file.

---

## 🌟 Why

* 🛡️ **100% private:** your data never leaves your router. No central servers, no cloud, no tracking.
* 💸 **Zero internet cost:** works fully offline — offices, warehouses, road trips, off-grid.
* ⚡ **Local speeds:** transfer files and talk with near-zero latency over your own Wi‑Fi.

---

## ⚡ Features

### 📻 Push-to-talk walkie-talkie
* Hold **HOLD TO SPEAK** (or hold **Space**) and your voice plays instantly on every device on the channel.
* The **transmission line animates with your actual voice** — the bars, glow, sparks and the
  button's vibration are all driven by the real microphone level, so silence means stillness and
  speech means motion. Automatic gain keeps quiet microphones just as lively as loud ones.
* **LISTENING** toggle mutes incoming walkie audio without disconnecting.

### 💬 Private chats & network broadcast
* 1‑on‑1 inbox with specific devices, plus a **broadcast channel** for everyone on the network.
* 99 channels; messages are de-duplicated across both transports so nothing arrives twice.

### 📁 Universal file sharing
* Send any file type at full local Wi‑Fi speed. Transfers are encrypted with AES‑256‑CTR and
  verified by length, so truncated or tampered files are rejected.

### 📞 Voice & video calls
* 1‑on‑1 local calls with live audio and camera video.

---

## 🛠️ How it works

* **Discovery** — mDNS/DNS‑SD service `_walkietalkie._tcp` (instance `WT-<displayName>`, TXT
  `displayName` / `model`), implemented in pure JavaScript so there are no native dependencies.
  A 30‑second `/24` subnet sweep and a 6‑second heartbeat keep the peer list fresh.
* **Signalling & files** — local **TCP**. Each packet is framed as
  `[magic 1 byte][length 4 bytes big-endian][JSON payload, UTF‑8]`, where magic `0x01` is a
  control packet and `0x02` introduces an encrypted file payload.
* **Encryption** — file payloads use **AES‑256‑CTR** with a 16‑byte random IV written ahead of
  the ciphertext. The key is the UTF‑8 bytes of `P2P_TACTICAL_DIRECT_BINARY_KEY` (30 bytes)
  zero-padded to 32 bytes — reproduced byte-for-byte so Android and Linux can exchange files.
* **Media** — raw UDP, *not* WebRTC. Signalling still exchanges SDP/ICE-style strings, but the
  actual media is plain UDP, which is what makes Android↔Linux calls interoperate.
* **Privacy** — nothing is stored beyond your own machine. Messages live in a local JSON store
  with an optional 2‑day auto‑delete.

### Ports

| Port | Transport | Purpose |
| :--- | :--- | :--- |
| 8888 | TCP | Signalling, chat, and encrypted file transfer |
| 8887 | UDP | Broadcast/multicast signalling discovery |
| 9999 | UDP | Walkie-talkie audio — raw PCM s16le, 16 kHz, mono |
| 8890 | UDP | Call audio — raw PCM s16le, 16 kHz, mono |
| 8889 | UDP | Call video — raw JPEG, ~480×360, quality 35, < 60000 bytes |

> If the desktop firewall prompts, allow incoming connections on these ports, otherwise other
> devices cannot discover or talk to this machine.

---

## 🚀 Running

Download the AppImage, then either double-click it or:

```sh
./WiFi-Walkie-Talkie-1.0.0-x86_64.AppImage
```

Making it permanent on your menu:

```sh
# user-wide
install -Dm755 WiFi-Walkie-Talkie-1.0.0-x86_64.AppImage ~/.local/bin/walkie-talkie

# or system-wide
sudo install -m755 WiFi-Walkie-Talkie-1.0.0-x86_64.AppImage /usr/local/bin/walkie-talkie
```

### Requirements

| | |
| :--- | :--- |
| Architecture | x86‑64 |
| glibc | **2.25 or newer** (Ubuntu 18.04 / Debian 10 and up) |
| Desktop | Any X11 or Wayland session |
| Audio | PulseAudio or PipeWire (for microphone capture) |

Everything else — Electron, Chromium, Node, the app, its icons, the optional
`libappindicator`/`libnotify` libraries **and the AppImage launcher itself** — is packed inside
the file. The launcher is statically linked and embeds its own FUSE implementation, so there is
**no `libfuse2` / `libfuse3` package to install** — a common problem with AppImages on
Ubuntu ≥ 24.04 and Debian ≥ 13.

The only thing the kernel must provide is FUSE support at `/dev/fuse`, which is enabled by default
on every mainstream desktop distribution.

> On the rare system where FUSE is disabled entirely (hardened servers, containers started without
> `--device /dev/fuse`), run it without mounting:
> ```sh
> ./WiFi-Walkie-Talkie-1.0.0-x86_64.AppImage --appimage-extract-and-run
> ```

The launcher supplies `--no-sandbox` automatically, because Chromium's setuid sandbox cannot
operate from inside a read-only squashfs mount.

---

## 🤝 Android ⇄ Linux

Both apps speak the same protocol, so they interoperate directly:

| Feature | Android | Linux |
| :--- | :---: | :---: |
| Discovery (`_walkietalkie._tcp`) | ✅ | ✅ |
| Broadcast + private chat | ✅ | ✅ |
| Encrypted file transfer | ✅ | ✅ |
| Push-to-talk audio | ✅ | ✅ |
| Voice / video call media | ✅ raw UDP | ✅ raw UDP |

Both must be on the **same subnet**. The walkie-talkie channel is simply a number carried in the
packet, so phones and desktops must be tuned to the same channel to hear each other.

---

## 🔒 Permissions & privacy

The app asks for microphone access only while you are transmitting or in a call. Camera access
happens only during a video call. No internet permission is required and none is used.

---

## 🛠️ Building from source

```sh
npm install          # electron + electron-builder
npm start            # run unpacked
npm test             # renderer consistency + 25-assertion P2P integration test
npm run dist         # AppImage via electron-builder
npm run build-appimage   # AppImage via scripts/build-appimage.sh (recommended)
```

`scripts/build-appimage.sh` assembles the AppImage directly, which lets us ship a cleaner
launcher (no first-run licence dialog, correct `APPDIR` handling, automatic `--no-sandbox`).

### Verification scripts

| Script | What it proves |
| :--- | :--- |
| `npm run test:renderer` | Every `$('id')` lookup in the renderer resolves to a real element, `classList` targets are styled, no duplicate top-level declarations across renderer scripts |
| `npm run test:integration` | 25 live assertions: port binding, broadcast address maths, PING/PONG, chat over TCP **and** UDP, 300 KB encrypted file relay recovered byte-exactly, audio/video frames, de-duplication, byte-by-byte reassembly, clean shutdown |
| `npm run test:crypto` | AES‑256‑CTR conformance, cross-checkable against a Java implementation of the Android `BinaryStreamRelay` |

---

## 📄 Licence

MIT — see [LICENSE](LICENSE).