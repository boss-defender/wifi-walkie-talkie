# 📻 WiFi Walkie-Talkie — Windows Desktop Edition

> **Talk, call, and share files instantly with anyone on your local Wi‑Fi — zero internet, zero cloud, 100% private.**

A self-contained **portable `.exe`** edition of the Android WiFi Walkie-Talkie. It is
protocol-compatible with the Android app: an Android phone and a Windows desktop on the same Wi‑Fi
discover each other and can talk, chat, send files and call each other.

```
WiFi-Walkie-Talkie-1.0.0-x64-portable.exe
```

**That is the entire installation.** Double-click it and it runs. Nothing to install, nothing
registered, nothing left behind — Electron, Chromium, Node.js, the application and its icon are all
packed inside that single ~65 MB file. To uninstall, delete the file.

---

# 🛠️ Want to build from scratch: 
**Just copy paste this to ai agent to build exe**
```text
You are an Electron and Windows packaging engineer. Inspect this project and build its portable Windows executable from the source.

## Required result

Produce one self-contained x64 Windows portable `.exe`, using this project’s Electron Builder `portable` target—not an installer. The expected output name is:

`WiFi-Walkie-Talkie-1.0.0-x64-portable.exe`

Users should be able to download the file and double-click it on Windows 10 or 11 x64. They must not need to install Node.js, npm packages, Electron, or an application installer. Bundle the app, Electron/Chromium runtime, application code, assets, and required app-specific runtime files inside the executable.

Preserve the project’s behavior and security checks. Do not add runtime downloads or external-service requirements. Keep the existing user-data behavior and documented Windows Firewall consent flow. Do not claim the executable is signed unless a real code-signing certificate was used.

## Build steps

1. Read `README.md`, `package.json`, `scripts/build-windows.sh`, and the verification scripts. Follow the existing build configuration where it works.
2. Use Node.js 18 or newer. If `package-lock.json` is missing, create and include one so dependency versions can be reproduced.
3. Install the project dependencies, run the project’s checks, and build with `npm run dist`.
4. Verify the output exists, is a Windows x64 portable executable, includes the expected icon/version/manifest resources, and is not an installer. Use the project’s verification script.
5. Test launching and core application behavior in a clean Windows 10/11 x64 environment. If a Windows environment or suitable compatibility test is unavailable, say exactly what was and was not verified.

## Report back

Give the exact build command, output path, architecture, signing status, test environment, and any remaining host requirements or limitations. Keep build caches, `node_modules/`, and generated `dist/` files out of the source folder.

```

---

## 🌟 Why

* 🛡️ **100% private:** your data never leaves your router. No central servers, no cloud, no tracking.
* 💸 **Zero internet cost:** works fully offline — offices, warehouses, road trips, off-grid.
* ⚡ **Local speeds:** transfer files and talk with near-zero latency over your own Wi‑Fi.

---

## ⚡ Features

### 📻 Push-to-talk walkie-talkie
* Hold **HOLD TO SPEAK** (or hold <kbd>Space</kbd>) and your voice plays instantly on every device on the channel.
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

## 🚀 Running

Download `WiFi-Walkie-Talkie-1.0.0-x64-portable.exe` and double-click it. On the very first run
Windows SmartScreen shows *"Windows protected your PC"* because the file is not code-signed. Click
**More info → Run anyway**. This is a one-time step per file, and it disappears entirely once the
application is signed (see [Code signing](#-code-signing)).

Nothing else is required: no .NET, no Visual C++ redistributables, no Node.js, no Python. The app
runs as a normal user and never asks for administrator rights.

### Requirements

| | |
| :--- | :--- |
| Architecture | x86-64 (64-bit Windows) |
| OS | Windows 10, Windows 11 |
| Disk | ~150 MB while running (the app unpacks itself to a temporary folder) |
| Network | Two or more devices on the **same local network** |
| Audio | Any microphone and speakers/headset |

Every device must be on the same subnet. Guest Wi-Fi and mobile hotspots commonly isolate clients
from each other, which prevents discovery — use a normal router, or a hotspot that does not enable
client isolation.

---

## 🔥 Windows Firewall — read this if you see "0 peers"

Windows blocks **all** incoming connections by default. This app only works if a few local ports are
open, so on the **first launch** the app asks:

> **Allow WiFi Walkie-Talkie through Windows Firewall?**
> *Allow on all networks* / *Private networks only* / *Not now*

Choose either allow option and Windows will show **one** UAC prompt. That is the only administrative
request the application ever makes, and it adds these inbound rules:

| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| 8888 | TCP | Signalling, chat, and encrypted file transfer |
| 5353 | UDP | Device discovery (mDNS / DNS-SD) |
| 8887 | UDP | Broadcast/multicast signalling discovery |
| 9999 | UDP | Walkie-talkie audio — raw PCM s16le, 16 kHz, mono |
| 8890 | UDP | Call audio — raw PCM s16le, 16 kHz, mono |
| 8889 | UDP | Call video — raw JPEG, ~480×360, quality 35, < 60000 bytes |

You can add, re-apply or remove these rules at any time in **Settings → Windows Firewall**, or by
hand from an elevated command prompt:

```powershell
netsh advfirewall firewall add rule name="WiFi Walkie-Talkie (inbound)" dir=in action=allow protocol=TCP localport=8888 enable=yes profile=any
netsh advfirewall firewall add rule name="WiFi Walkie-Talkie (inbound)" dir=in action=allow protocol=UDP localport=5353,8887,8889,8890,9999 enable=yes profile=any

# and to remove them
netsh advfirewall firewall delete rule name="WiFi Walkie-Talkie (inbound)"
```

> The rules are **not** restricted to a specific program, because a portable single-file build
> unpacks itself into a fresh temporary folder on every run and a program-scoped rule would stop
> matching after the next restart. The ports are opened for the network profiles you chose, and the
> app can close them again on request.

If you chose *Private networks only* and later join a network Windows marks as **Public**, the
app will stop discovering peers — reopen **Settings → Windows Firewall → Allow incoming connections**.

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
  zero‑padded to 32 bytes — reproduced byte‑for‑byte so Android and Windows can exchange files.
* **Media** — raw UDP, *not* WebRTC. Signalling still exchanges SDP/ICE‑style strings, but the
  actual media is plain UDP, which is what makes Android↔Windows calls interoperate.
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

### Where your data lives

| | |
| :--- | :--- |
| Messages, preferences | `%APPDATA%\WiFi Walkie-Talkie\` |
| Received files | `%APPDATA%\WiFi Walkie-Talkie\received\` |

Both survive updates and restarts — only deleting the `.exe` removes the application itself, never
your messages. **Settings → Storage → Open received-files folder** opens the folder directly.

---

## 📱 Android ⇄ Windows

Both apps speak the same protocol, so they interoperate directly:

| Feature | Android | Windows |
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
happens only during a video call. No internet permission is required and none is used. There is no
telemetry, no analytics and no account — closing the window stops all network activity.

---

## 💾 How the portable .exe works

The file is a self-extracting archive. On launch it unpacks itself into a temporary folder, runs,
and cleans up on exit. This is why the first start takes a second or two longer than an installed
application — and why there is nothing to install.

> **Note:** if you move or rename the `.exe` while it is running, or run two copies from different
> folders, Windows may refuse the second one because both claim the same single-instance lock. This
> is normal; only one copy can run at a time.

---

## 🔐 Code signing

The shipped `.exe` is **unsigned**, which is why SmartScreen warns on first run. To sign it, obtain
an OV or EV code-signing certificate and export the path and password:

```sh
export CSC_LINK=/path/to/certificate.pfx
export CSC_KEY_PASSWORD='your-password'
npm run dist
```

Nothing else changes — `electron-builder` picks the environment variables up automatically and the
result is a fully signed `.exe` that SmartScreen reports as known publisher.

---

## 🛠️ Building from source

Requires Node.js 18+ (a portable copy is vendored in `.buildtools/node`).

```sh
npm install                # electron + electron-builder
npm start                  # run unpacked (development)
npm test                   # renderer checks + 30-assertion P2P integration test
npm run dist               # -> dist/WiFi-Walkie-Talkie-1.0.0-x64-portable.exe
npm run icons              # regenerate the PNG set and build/icon.ico
```

A Windows build can be produced from **Linux or macOS** — no Windows machine and no Wine required.
`electron-builder` downloads the Windows Electron distribution, rewrites the executable's icon and
version resources with the pure-JS `resedit` library and runs NSIS' own `makensis` binary.

### Verification scripts

| Script | What it proves |
| :--- | :--- |
| `npm run test:renderer` | Every `$('id')` lookup resolves to a real, **unique** element, `classList` targets are styled, no duplicate top-level declarations across renderer scripts, every icon name resolves, and no emoji have crept back into the UI |
| `npm run test:integration` | 30 live assertions: port binding, broadcast address maths, PING/PONG, chat over TCP **and** UDP, 300 KB encrypted file relay recovered byte-exactly, audio/video frames, de-duplication, byte-by-byte reassembly, clean shutdown |
| `npm run test:crypto` | AES‑256‑CTR conformance, cross-checkable against a Java implementation of the Android `BinaryStreamRelay` |
| `node scripts/verify-exe.js <exe>` | The built executable carries a 7-size icon group, a correct version resource, and a manifest that runs as a normal user |
| `bash scripts/smoke-windows.sh` | Launches the **shipped `.exe`** under Wine, confirms all five P2P sockets bind, that user data persists to `%APPDATA%`, that the archive is self-contained, and that it exits cleanly |

---

## 📄 Licence

MIT — see [LICENSE](LICENSE).
