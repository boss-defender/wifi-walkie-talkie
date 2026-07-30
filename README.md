# 📻 Wi-Fi Walkie-Talkie & Local Mesh Messenger

> **Talk, call, and share files instantly with anyone on your local Wi-Fi — zero internet required, zero cloud servers, and 100% private.**

---
## App Link: 

https://drive.google.com/file/d/16RLXD3sIe2VEP0gpBGif9qm1dKVeyG1W/view?usp=sharing

zip password : 1234
---
## 🌟 Why Use This App? (The Big Benefits)

* 🛡️ **100% Serverless & Private:** Your data **never leaves your router**. There are no central servers, no cloud databases, and no tracking. Everything is peer-to-peer (P2P).
* 💸 **Zero Data/Internet Costs:** Works completely offline! Perfect for office floors, home networks, warehouses, road trips, or off-grid emergency scenarios.
* ⚡ **Ultra-Fast Local Speeds:** Transfer huge files, stream video, and talk with near-zero latency using your Wi-Fi router's maximum speed.
* 🚫 **No Sneaky Permissions:** **Zero location permissions required.** We respect your privacy.

---

## ⚡ Key Features

### 📻 1. Real-Time Walkie-Talkie (Push-To-Talk)
* **Instant Voice Broadcast:** Hold the PTT button and speak — your voice instantly plays through the speakers of all connected devices on the network.
* **Low-Latency Audio:** Powered by Opus compression and low-latency audio pipelines for crisp, crackle-free voice even on 2.4 GHz Wi-Fi.
* **Mute/Listen Toggle:** Turn incoming walkie-talkie audio ON or OFF with a single tap.
* **Background Mode:** Keeps listening even when your phone screen is locked or the app is minimized.
* **Files Sharing:** Send up to 500 Kb size of any type of file. 

### 💬 2. Private Chats & Network Broadcasting
* **1-on-1 Private Inbox:** Chat directly with specific devices connected to the same Wi-Fi.
* **Broadcast Channel:** Send text, voice notes, or announcements to everyone on the network simultaneously.
* **Zero Lost Messages:** Reliable packet framing ensures your messages get delivered instantly without duplicates or dropped texts.

### 📁 3. Universal File Sharing
* Send photos, HD videos, PDFs, audio clips, zip files, or documents of **any size** at full local Wi-Fi speeds.

### 📞 4. High-Quality Voice & Video Calls
* **1-on-1 Local Calls:** Smooth, low-lag WebRTC voice and video calling directly between devices over local sockets.
* **Built-in Audio Enhancements:** Hardware Echo Cancellation and Noise Suppression keep audio crystal clear.

---

## 🛠️ How It Works (Under the Hood)

* **Automatic Peer Discovery:** Uses Android Network Service Discovery (mDNS/NSD) to auto-detect nearby phones connected to the same Wi-Fi router or mesh extender.
* **Direct Socket Connections:** Uses local TCP sockets for messaging/file transfers and UDP Multicast for instant Walkie-Talkie audio streaming.
* **Local WebRTC:** Direct device-to-device audio/video streaming without external STUN/TURN servers.
* **Ephemeral Architecture:** Messages exist only in memory during active connections. Once devices disconnect, data clears out naturally.

---

## 📱 Prerequisites & Setup

1. **Same Wi-Fi Network:** Connect all Android devices to the same Wi-Fi network (works across multiple mesh routers and Wi-Fi extenders).
2. **Install & Run:** Open the app on two or more devices — they will automatically discover each other in seconds!
3. **Set Display Name:** Tap your device name at the top to set your custom handle.

---

## 🔒 Permissions & Privacy

We value your trust. Here is why the app requests specific permissions:

| Permission | Purpose |
| :--- | :--- |
| 🎙️ `RECORD_AUDIO` | Needed for live Walkie-Talkie voice streaming and calls. |
| 📷 `CAMERA` | Needed for video calls. |
| 📡 `NEARBY_WIFI_DEVICES` | Used to discover peers on the local Wi-Fi network. |
| 🔔 `POST_NOTIFICATIONS` | Keeps the background Walkie-Talkie listener service running reliably. |


---


