'use strict';
/**
 * media.js — Real-time media transports.
 *
 * Port/format compatible with the Android client:
 *
 *  Walkie-talkie (com.example.network.UdpAudioEngine)
 *    UDP :9999  raw PCM signed-16 LE, 16 kHz, mono.
 *    Sender blasts peers + 239.255.0.1 + 255.255.255.255.
 *
 *  Calls (com.example.network.LocalCallEngine)
 *    UDP :8890  raw PCM signed-16 LE, 16 kHz, mono (uni-cast).
 *    UDP :8889  raw JPEG frames (< 60000 bytes, ~480x360, quality 35).
 *
 * Capture and playback themselves happen in the renderer through the Web Audio
 * API (no native audio modules are required inside the AppImage); this module
 * only owns the sockets and forwards frames over IPC.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const proto = require('./protocol');

const MAX_FRAME = 65536;

/**
 * Creates a UDP socket bound to `port` with SO_REUSEADDR and an optional group.
 *
 * `ifaceAddress` is the local IPv4 address that owns the socket. On Windows a
 * machine is very often multi-homed (Ethernet + Wi-Fi + a VPN), and both
 * multicast membership and multicast routing default to whatever adapter the
 * routing table happens to favour — which is regularly the wrong one. Passing
 * the address pins the socket to the interface the rest of the app picked.
 */
function createUdpSocket(port, multicastGroup, onMessage, ifaceAddress) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let membershipDone = false;

  socket.on('error', (err) => {
    // Losing a socket must never take the whole app down.
    console.error(`[media] UDP socket error on ${port}:`, err.message);
  });

  socket.bind(port, () => {
    try {
      socket.setBroadcast(true);
    } catch (_e) { /* not fatal */ }
    if (ifaceAddress) {
      try {
        socket.setMulticastInterface(ifaceAddress);
      } catch (_e) { /* falls back to the default route */ }
    }
    if (multicastGroup && !membershipDone) {
      membershipDone = true;
      try {
        if (ifaceAddress) socket.addMembership(multicastGroup, ifaceAddress);
        else socket.addMembership(multicastGroup);
        socket.setMulticastLoopback(true);
        socket.setMulticastTTL(1);
      } catch (_e) {
        console.warn(`[media] multicast join ${multicastGroup} failed, unicast still works`);
      }
    }
  });

  if (onMessage) {
    socket.on('message', (msg, rinfo) => {
      try {
        onMessage(msg, rinfo);
      } catch (e) {
        console.error('[media] message handler error:', e.message);
      }
    });
  }

  return socket;
}

class MediaEngine extends EventEmitter {
  constructor() {
    super();

    this.walkieSocket = null;
    this.walkieSendSocket = null;
    this.callAudioSocket = null;
    this.callVideoSocket = null;

    this.localIp = '127.0.0.1';
    this.broadcastAddress = null;
    this.transmitting = false;

    this._walkieTargets = [];
    this._callTargets = [];
  }

  start(localIp, broadcastAddress) {
    this.localIp = localIp;
    this.broadcastAddress = broadcastAddress;
    this._bind();
  }

  _bind() {
    // -- walkie-talkie listener ------------------------------------------
    this.walkieSocket = createUdpSocket(
      proto.UDP_AUDIO_PORT,
      proto.MULTICAST_IP,
      (msg, rinfo) => {
        if (msg.length === 0 || msg.length > MAX_FRAME) return;
        if (this._isSelf(rinfo.address)) return;
        this.emit('walkie-frame', {
          // base64 keeps the binary payload intact across the IPC boundary
          pcm: msg.toString('base64'),
          bytes: msg.length,
          from: rinfo.address,
        });
      },
      this.localIp,
    );

    // Separate ephemeral socket for transmission: a socket that both reads and
    // writes the same multicast group would echo our own voice back to us.
    const sendSocket = dgram.createSocket('udp4');
    this.walkieSendSocket = sendSocket;
    sendSocket.on('error', (err) => {
      console.error('[media] walkie send socket error:', err.message);
    });
    try {
      // `sendSocket` is captured rather than read back off `this`, because the
      // bind callback can fire after stop() has already nulled the field.
      sendSocket.bind(0, () => {
        try { sendSocket.setBroadcast(true); } catch (_e) { /* not fatal */ }
        if (this.localIp) {
          try { sendSocket.setMulticastInterface(this.localIp); } catch (_e) { /* default route */ }
        }
      });
    } catch (_e) { /* ignore */ }

    // -- call media listeners --------------------------------------------
    this.callAudioSocket = createUdpSocket(
      proto.CALL_AUDIO_PORT,
      null,
      (msg, rinfo) => {
        if (msg.length === 0 || msg.length > MAX_FRAME) return;
        if (this._isSelf(rinfo.address)) return;
        this.emit('call-audio-frame', {
          pcm: msg.toString('base64'),
          bytes: msg.length,
          from: rinfo.address,
        });
      },
      this.localIp,
    );

    this.callVideoSocket = createUdpSocket(proto.CALL_VIDEO_PORT, null, (msg, rinfo) => {
      if (msg.length < 2 || msg.length > 60000) return;
      if (this._isSelf(rinfo.address)) return;
      this.emit('call-video-frame', {
        jpeg: msg.toString('base64'),
        bytes: msg.length,
        from: rinfo.address,
      });
    }, this.localIp);
  }

  /**
   * True when a datagram came from this machine.
   *
   * A socket that has joined a multicast group receives its own transmissions
   * back through multicast loopback, and Windows routes that loopback as long as
   * any adapter has a multicast route — even the VPN one. Without this filter a
   * user hears the tail of their own transmission a fraction of a second after
   * releasing push-to-talk.
   */
  _isSelf(address) {
    return !!address && !!this.localIp && address === this.localIp;
  }

  /**
   * Point the sockets at a (possibly changed) local address.
   * Called on every heartbeat because a laptop can move between Wi-Fi networks
   * without the app restarting.
   */
  setInterface(address, broadcastAddress) {
    if (address) this.localIp = address;
    if (broadcastAddress !== undefined) this.broadcastAddress = broadcastAddress;

    const sockets = [this.walkieSocket, this.callAudioSocket, this.callVideoSocket, this.walkieSendSocket];
    for (const socket of sockets) {
      if (!socket || !this.localIp) continue;
      try {
        socket.setMulticastInterface(this.localIp);
      } catch (_e) { /* the socket may not be bound yet; not fatal */ }
    }
  }

  setWalkieTargets(peerIps) {
    const set = new Set();
    for (const ip of peerIps) {
      if (ip && ip !== this.localIp && ip !== '0.0.0.0' && ip !== '127.0.0.1') set.add(ip);
    }
    this._walkieTargets = Array.from(set);
  }

  setCallTargets(peerIps) {
    const set = new Set();
    for (const ip of peerIps) {
      if (ip && ip !== this.localIp && ip !== '0.0.0.0' && ip !== '127.0.0.1') set.add(ip);
    }
    this._callTargets = Array.from(set);
  }

  setTransmitting(value) {
    this.transmitting = !!value;
  }

  /** Broadcast one PCM chunk from the walkie-talkie microphone. */
  sendWalkieFrame(buffer) {
    if (!buffer || buffer.length === 0 || !this.walkieSendSocket) return 0;
    const targets = new Set();
    for (const ip of this._walkieTargets) targets.add(ip);
    targets.add(proto.MULTICAST_IP);
    targets.add('255.255.255.255');
    if (this.broadcastAddress) targets.add(this.broadcastAddress);

    let sent = 0;
    for (const address of targets) {
      try {
        this.walkieSendSocket.send(buffer, 0, buffer.length, proto.UDP_AUDIO_PORT, address, (err) => {
          if (err) { /* destination unreachable is normal on a LAN */ }
        });
        sent += 1;
      } catch (_e) { /* ignore unreachable destinations */ }
    }
    return sent;
  }

  /** Send call audio (PCM) to the active call peer(s). */
  sendCallAudio(buffer) {
    if (!buffer || buffer.length === 0 || !this.callAudioSocket) return 0;
    let sent = 0;
    for (const ip of this._callTargets) {
      try {
        this.callAudioSocket.send(buffer, 0, buffer.length, proto.CALL_AUDIO_PORT, ip, () => {});
        sent += 1;
      } catch (_e) { /* ignore */ }
    }
    return sent;
  }

  /** Send one encoded camera frame (JPEG) to the active call peer(s). */
  sendCallVideo(buffer) {
    if (!buffer || buffer.length === 0 || !this.callVideoSocket) return 0;
    let sent = 0;
    for (const ip of this._callTargets) {
      try {
        this.callVideoSocket.send(buffer, 0, buffer.length, proto.CALL_VIDEO_PORT, ip, () => {});
        sent += 1;
      } catch (_e) { /* ignore */ }
    }
    return sent;
  }

  stop() {
    const close = (socket) => {
      if (socket) {
        try { socket.close(); } catch (_e) { /* ignore */ }
      }
    };
    close(this.walkieSocket);
    close(this.walkieSendSocket);
    close(this.callAudioSocket);
    close(this.callVideoSocket);
    this.walkieSocket = null;
    this.walkieSendSocket = null;
    this.callAudioSocket = null;
    this.callVideoSocket = null;
  }
}

module.exports = { MediaEngine, createUdpSocket };