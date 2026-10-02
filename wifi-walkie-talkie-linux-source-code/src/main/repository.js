'use strict';
/**
 * repository.js — Peer-to-peer orchestration.
 *
 * Direct port of com.example.repository.P2PRepository:
 *   - TCP signal/file server on :8888
 *   - UDP broadcast/multicast signal channel on :8887
 *   - mDNS discovery of `_walkietalkie._tcp`
 *   - heartbeat PING/PONG with RTT measurement
 *   - 6 s reconnect manager and 30 s /24 LAN recovery sweep
 *   - packet-loss watchdog driving silent reconnects
 *   - private chat, broadcast chat, file relay, call signalling
 *   - automatic cleanup of non-starred messages older than 2 days
 */

const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const proto = require('./protocol');
const netutil = require('./netutil');
const { MdnsService } = require('./mdns');
const { MediaEngine } = require('./media');

const ConnectionStatus = {
  CONNECTED: 'CONNECTED',
  SEARCHING: 'SEARCHING',
  DISCONNECTED: 'DISCONNECTED',
};

const PEER_UNREACHABLE_MS = 45000;
const PEER_OFFLINE_MS = 120000;
const LAN_SCAN_INTERVAL_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 6000;
const MSG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

const AVATAR_COLORS = [0xff3b82f6, 0xff34d399, 0xfff59e0b, 0xffa855f7, 0xffec4899, 0xff06b6d4, 0xfff97316, 0xff84cc16];

class P2PRepository extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.onStateChange = options.onStateChange || (() => {});

    const saved = store.getPref('custom_display_name');
    this.deviceId = `Linux-${proto.uuid().slice(0, 4)}`;
    this.displayName = saved && saved.trim() ? saved.trim() : this._defaultName();

    this.currentChannel = 1;
    this.autoDeleteOldMessages = store.getPref('auto_delete_old_messages') !== false;

    this.localIp = '127.0.0.1';
    this.ssid = 'Local Network';
    this.interfaceName = null;
    this.broadcastAddress = null;

    /** @type {Map<string, object>} ip -> peer record */
    this.peers = new Map();
    /** Bounded de-duplication window shared by both transports. */
    this.processedMsgIds = new Set();
    this.processedOrder = [];

    this.tcpServer = null;
    this.signalSocket = null;
    this.mdns = null;
    this.media = new MediaEngine();

    this.watchdog = { sent: new Map(), received: new Map(), highLossSince: new Map() };
    // Most recent inbound text/file, surfaced in the snapshot so the renderer
    // can react even while the user is on a different tab.
    this.lastIncoming = null;

    this.timers = { heartbeat: null, lanScan: null, cleanup: null };

    this.running = false;

    // Call state
    this.incomingCall = null;
    this.activeCall = null;
    this.callMicMuted = false;
    this.callVideoEnabled = true;
  }

  _defaultName() {
    const suffix = this.deviceId.slice(-4).toUpperCase();
    return `Walkie-User-${suffix}`;
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  start() {
    if (this.running) return;
    this.running = true;

    this._refreshNetwork();
    this._startTcpServer();
    this._startSignalSocket();
    this._startMdns();
    this._startWatchdog();
    this.media.start(this.localIp, this.broadcastAddress);

    this.timers.heartbeat = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.timers.lanScan = setInterval(() => this._lanRecoveryScan(), LAN_SCAN_INTERVAL_MS);
    this.timers.cleanup = setInterval(() => this._autoCleanup(), CLEANUP_INTERVAL_MS);

    // First sweep shortly after boot, then let the intervals take over.
    setTimeout(() => this._lanRecoveryScan(), 1500);

    this._safeState('started');
    console.log('[repo] P2P services started on', this.localIp);
  }

  stop() {
    if (!this.running) return;
    this.running = false;

    for (const key of Object.keys(this.timers)) {
      if (this.timers[key]) clearInterval(this.timers[key]);
      this.timers[key] = null;
    }

    if (this.mdns) {
      try { this.mdns.stop(); } catch (_e) { /* ignore */ }
      this.mdns = null;
    }
    if (this.signalSocket) {
      try { this.signalSocket.close(); } catch (_e) { /* ignore */ }
      this.signalSocket = null;
    }
    if (this.tcpServer) {
      try { this.tcpServer.close(); } catch (_e) { /* ignore */ }
      this.tcpServer = null;
    }
    this.media.stop();
    this.store.close();
    console.log('[repo] P2P services stopped');
  }

  _safeState(reason) {
    try {
      this.onStateChange(this.snapshot(), reason);
    } catch (e) {
      console.error('[repo] state callback failed:', e.message);
    }
  }

  _refreshNetwork() {
    const iface = netutil.getPrimaryInterface();
    this.localIp = iface ? iface.address : '127.0.0.1';
    this.interfaceName = iface ? iface.name : null;
    this.broadcastAddress = iface ? iface.broadcast : null;
    this.ssid = netutil.guessSsid(this.interfaceName);
    if (this.mdns) this.mdns.updateAddress(this.localIp);
    this.media.localIp = this.localIp;
    this.media.broadcastAddress = this.broadcastAddress;
    return iface;
  }

  // =========================================================================
  // TCP server (:8888)
  // =========================================================================

  _startTcpServer() {
    this.tcpServer = net.createServer((socket) => this._handleConnection(socket));
    this.tcpServer.on('error', (err) => {
      console.error('[repo] TCP server error:', err.message);
      this._safeState('tcp-server-error');
    });
    this.tcpServer.listen(proto.SERVER_PORT, '0.0.0.0', () => {
      console.log(`[repo] TCP P2P server listening on ${proto.SERVER_PORT}`);
      this._safeState('tcp-ready');
    });
  }

  _handleConnection(socket) {
    const clientIp = socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : '';
    socket.setNoDelay(true);
    socket.setTimeout(15000);

    const reader = new proto.FrameReader((magic, payload) => {
      socket.setTimeout(0);
      try {
        if (magic === proto.MAGIC_PACKET) {
          const packet = proto.packetFromJson(payload.toString('utf8'));
          if (packet) this._handleIncomingPacket(packet, clientIp);
          return;
        }
        if (magic === proto.MAGIC_FILE) {
          const header = proto.packetFromJson(payload.toString('utf8'));
          // The rest of this connection is a raw file payload, so stop the
          // frame reader from interpreting those bytes as more frames.
          const remainder = reader.takeRemainder();
          if (header) this._beginFileReceive(socket, reader, header, clientIp, remainder);
          else socket.destroy();
          return;
        }
      } catch (e) {
        console.error('[repo] frame handling error:', e.message);
      }
    });

    const onData = (chunk) => reader.push(chunk);
    socket.on('data', onData);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => socket.destroy());
  }

  /**
   * Switch a connection into raw file-payload mode.
   *
   * The very same 'data' listener keeps feeding the FrameReader, which now
   * forwards bytes verbatim. That keeps a single listener on the socket for
   * the whole connection — swapping listeners mid-stream is what silently
   * truncates transfers.
   */
  _beginFileReceive(socket, reader, header, senderIp, remainder) {
    socket.setTimeout(30 * 60 * 1000);

    const fileName = sanitizeFileName(header.payload || 'received.bin');
    const expected = Number.parseInt(header.extraData || '0', 10) || 0;

    try {
      fs.mkdirSync(this.store.receivedDir, { recursive: true });
    } catch (e) {
      console.error('[repo] cannot create received dir:', e.message);
      socket.destroy();
      return;
    }

    const dest = uniquePath(this.store.receivedDir, fileName);
    const dec = new proto.FileDecryptStream();
    let finished = false;

    const complete = (result) => {
      if (finished) return;
      finished = true;
      if (result && result.ok) {
        this._handleIncomingFile(dest, header, senderIp);
      } else {
        console.error('[repo] file transfer failed:', result ? result.reason : 'unknown');
      }
      try { socket.end(); } catch (_e) { socket.destroy(); }
    };

    const sink = (chunk) => {
      if (finished) return;
      try {
        dec.write(chunk);
      } catch (e) {
        complete({ ok: false, reason: 'decrypt: ' + e.message });
      }
    };

    // Bytes that shared the header's TCP segment belong to the payload.
    reader.setRawHandler(sink);
    if (remainder && remainder.length > 0) sink(remainder);

    // 'end' and 'close' both fire on a normal shutdown, so the finalize result
    // is memoised and only the first outcome is acted upon.
    let finalizing = null;
    const finalizeOnce = () => {
      if (!finalizing) finalizing = dec.finalize(dest, expected);
      return finalizing;
    };

    socket.on('end', () => { finalizeOnce().then(complete); });
    // A socket that closes without 'end' still gets its buffered bytes flushed.
    socket.on('close', () => { finalizeOnce().then(complete); });
    socket.on('error', (err) => {
      console.error('[repo] file socket error:', err.message);
      complete({ ok: false, reason: err.message });
    });
  }

  // =========================================================================
  // UDP signalling channel (:8887)
  // =========================================================================

  _startSignalSocket() {
    this.signalSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.signalSocket.on('error', (err) => {
      console.error('[repo] signal socket error:', err.message);
    });
    this.signalSocket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const packet = proto.packetFromJson(text);
      if (packet) this._handleIncomingPacket(packet, rinfo.address);
    });

    this.signalSocket.bind(proto.UDP_BROADCAST_PORT, () => {
      try {
        this.signalSocket.setBroadcast(true);
        this.signalSocket.addMembership(proto.MULTICAST_IP);
      } catch (_e) {
        console.warn('[repo] multicast join failed; broadcast signalling still active');
      }
      console.log(`[repo] UDP broadcast listener on ${proto.UDP_BROADCAST_PORT}`);
    });
  }

  sendSignalBroadcast(packet) {
    if (!this.signalSocket) return 0;
    const bytes = Buffer.from(proto.packetToJson(packet), 'utf8');
    const targets = new Set(['255.255.255.255', proto.MULTICAST_IP]);
    if (this.broadcastAddress) targets.add(this.broadcastAddress);

    let sent = 0;
    for (const address of targets) {
      try {
        this.signalSocket.send(bytes, 0, bytes.length, proto.UDP_BROADCAST_PORT, address, () => {});
        sent += 1;
      } catch (_e) { /* ignore */ }
    }
    return sent;
  }

  // =========================================================================
  // mDNS
  // =========================================================================

  _startMdns() {
    const model = `${os.type()} ${os.arch()}`;
    this.mdns = new MdnsService({
      serviceType: proto.SERVICE_TYPE,
      port: proto.SERVER_PORT,
      displayName: this.displayName,
      model,
      address: this.localIp,
      hostname: os.hostname(),
    });

    this.mdns.on('peer', (peer) => {
      if (!peer.address || peer.address === this.localIp) return;
      this._onPeerDiscovered(peer);
    });
    this.mdns.on('peerLost', ({ serviceName }) => this._onPeerLost(serviceName));
    this.mdns.on('conflict', ({ previous, next }) => {
      console.warn(`[repo] mDNS name conflict: ${previous} -> ${next}`);
      this._safeState('mdns-conflict');
    });
    this.mdns.on('error', (err) => console.error('[repo] mDNS error:', err.message));

    this.mdns.start();
  }

  // =========================================================================
  // peers
  // =========================================================================

  _onPeerDiscovered(discovered) {
    const ip = discovered.address;
    if (!ip || ip === this.localIp) return;

    const displayName = discovered.displayName && discovered.displayName.trim()
      ? discovered.displayName
      : `Peer-${ip}`;

    this._purgeStaleAddresses(ip, displayName);

    const peer = this.store.upsertPeer(ip, {
      displayName,
      ipAddress: ip,
      port: discovered.port || proto.SERVER_PORT,
      lastSeen: Date.now(),
      isOnline: true,
      isUnreachable: false,
    });

    this.peers.set(ip, peer);
    this._syncMediaTargets();
    this._safeState('peer-discovered');
  }

  _onPeerLost(serviceName) {
    let changed = false;
    for (const [ip, peer] of this.peers) {
      // mDNS service names are `WT-<displayName>._walkietalkie._tcp.local`
      if (peer.displayName && serviceName.includes(peer.displayName.replace(/([\\.])/g, '\\$1'))) {
        const next = this.store.upsertPeer(ip, { isOnline: false });
        this.peers.set(ip, next);
        changed = true;
      }
    }
    if (changed) this._safeState('peer-lost');
  }

  /** Drop entries for the same device that moved to a new IP. */
  _purgeStaleAddresses(ip, displayName) {
    for (const oldIp of Array.from(this.peers.keys())) {
      if (oldIp === ip) continue;
      const oldPeer = this.peers.get(oldIp);
      if (oldPeer && oldPeer.displayName === displayName) {
        this.peers.delete(oldIp);
        this.store.deletePeer(oldIp);
      }
    }
  }

  _updatePeerHeartbeat(ip, name, rtt) {
    const existing = this.peers.get(ip) || this.store.getPeer(ip);
    const displayName = name && name.trim()
      ? name
      : (existing && existing.displayName) || `Peer-${ip}`;

    this._purgeStaleAddresses(ip, displayName);

    const patch = {
      displayName,
      ipAddress: ip,
      port: proto.SERVER_PORT,
      lastSeen: Date.now(),
      isOnline: true,
      isUnreachable: false,
    };
    if (rtt >= 0) patch.rttMs = rtt;

    const peer = this.store.upsertPeer(ip, patch);
    this.peers.set(ip, peer);
    this._syncMediaTargets();
    this._safeState('heartbeat');
  }

  _syncMediaTargets() {
    const ips = [];
    for (const [ip, peer] of this.peers) {
      if (peer.isOnline && ip !== this.localIp) ips.push(ip);
    }
    this.media.setWalkieTargets(ips);
    if (this.activeCall) this.media.setCallTargets([this.activeCall.peerIp]);
  }

  orderedPeers() {
    const localIp = this.localIp;
    const self = this.store.upsertPeer(localIp, {
      id: localIp,
      displayName: `${this.displayName} (You)`,
      ipAddress: localIp,
      port: proto.SERVER_PORT,
      lastSeen: Date.now(),
      isOnline: true,
    });
    const others = Array.from(this.peers.values())
      .filter((p) => p.ipAddress !== localIp)
      .sort((a, b) => Math.max(b.lastMessageTime, b.lastSeen) - Math.max(a.lastMessageTime, a.lastSeen));
    return [self, ...others];
  }

  connectionStatus() {
    if (!this.localIp || this.localIp === '0.0.0.0' || this.localIp === '127.0.0.1') {
      return ConnectionStatus.DISCONNECTED;
    }
    const remote = Array.from(this.peers.values()).filter(
      (p) => p.ipAddress !== this.localIp && p.isOnline,
    );
    return remote.length > 0 ? ConnectionStatus.CONNECTED : ConnectionStatus.SEARCHING;
  }

  // =========================================================================
  // watchdog / heartbeat / LAN sweep
  // =========================================================================

  _startWatchdog() {
    this.watchdog.timer = setInterval(() => this._evaluateSocketHealth(), 1000);
  }

  _watchdogRecord(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  _evaluateSocketHealth() {
    const now = Date.now();
    const allKeys = new Set([...this.watchdog.sent.keys(), ...this.watchdog.received.keys()]);

    for (const key of allKeys) {
      const sent = this.watchdog.sent.get(key) || 0;
      const received = this.watchdog.received.get(key) || 0;

      if (sent >= 3) {
        const loss = (sent - Math.min(received, sent)) / sent;
        if (loss > 0.3) {
          const since = this.watchdog.highLossSince.get(key) || 0;
          if (since === 0) {
            this.watchdog.highLossSince.set(key, now);
          } else if (now - since >= 5000) {
            console.warn(`[repo] packet loss >30% for ${key}; triggering silent reconnect`);
            this.watchdog.sent.set(key, 0);
            this.watchdog.received.set(key, 0);
            this.watchdog.highLossSince.delete(key);
            this._silentReconnect(key);
          }
        } else {
          this.watchdog.highLossSince.delete(key);
        }
      }

      if (sent > 20 || received > 20) {
        this.watchdog.sent.set(key, 0);
        this.watchdog.received.set(key, 0);
      }
    }
  }

  _silentReconnect(peerIp) {
    try {
      if (this.mdns) {
        this.mdns._queryAll();
      }
      const ping = this._makePacket(proto.SignalType.PING, String(Date.now()));
      this.sendSignalBroadcast(ping);
      this._scanSubnet(ping);
      if (peerIp && peerIp !== 'GLOBAL' && peerIp !== this.localIp) {
        this.sendPacket(peerIp, proto.SERVER_PORT, ping);
      }
    } catch (e) {
      console.error('[repo] silent reconnect error:', e.message);
    }
  }

  _heartbeat() {
    try {
      this._refreshNetwork();

      const ping = this._makePacket(proto.SignalType.PING, String(Date.now()));
      this._watchdogRecord(this.watchdog.sent, 'GLOBAL');
      this.sendSignalBroadcast(ping);

      for (const [ip, peer] of this.peers) {
        if (ip === this.localIp) continue;
        this._watchdogRecord(this.watchdog.sent, ip);
        this.sendPacket(ip, peer.port || proto.SERVER_PORT, ping);
      }

      const now = Date.now();
      let nsdRefresh = false;
      for (const [ip, peer] of this.peers) {
        if (ip === this.localIp) continue;
        const elapsed = now - peer.lastSeen;
        if (elapsed > PEER_UNREACHABLE_MS && !peer.isUnreachable) {
          this.peers.set(ip, this.store.upsertPeer(ip, { isUnreachable: true, rttMs: -1 }));
          nsdRefresh = true;
        } else if (elapsed > PEER_OFFLINE_MS && peer.isOnline) {
          this.peers.set(ip, this.store.upsertPeer(ip, { isOnline: false, isUnreachable: true, rttMs: -1 }));
        }
      }

      if (nsdRefresh && this.mdns) this.mdns._queryAll();

      this._syncMediaTargets();
      this._safeState('heartbeat');
    } catch (e) {
      console.error('[repo] heartbeat error:', e.message);
    }
  }

  /**
   * User-triggered rescan.
   *
   * The existing "Rescan" control only showed a toast; it never actually
   * searched. This performs a real sweep: mDNS query + broadcast PING + a /24
   * probe, then resolves once the replies have had a moment to arrive so the
   * caller can report an accurate peer count.
   */
  async rescan() {
    const before = this.peers.size;
    try {
      this._refreshNetwork();
      if (this.mdns) this.mdns._queryAll();

      const ping = this._makePacket(proto.SignalType.PING, String(Date.now()));
      this._watchdogRecord(this.watchdog.sent, 'GLOBAL');
      this.sendSignalBroadcast(ping);
      this._scanSubnet(ping);

      // Give peers a chance to answer before reporting.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const found = this.orderedPeers().length;
      console.log(`[repo] rescan: ${before} -> ${found} peer(s) on ${this.localIp}`);
      this._safeState('rescan');
      return { ok: true, peers: found, added: Math.max(0, found - before) };
    } catch (e) {
      console.error('[repo] rescan failed:', e.message);
      return { ok: false, error: e.message, peers: this.peers.size };
    }
  }

  _lanRecoveryScan() {
    try {
      this._refreshNetwork();
      const ping = this._makePacket(proto.SignalType.PING, String(Date.now()));
      this._scanSubnet(ping);
    } catch (e) {
      console.error('[repo] LAN recovery scan error:', e.message);
    }
  }

  /** Probe the /24 with PING packets; 32 sockets are kept busy in parallel. */
  _scanSubnet(ping) {
    const known = Array.from(this.peers.keys());
    const sweep = netutil.classCSweep(this.localIp);
    const targets = Array.from(new Set([...known, ...sweep])).filter(
      (ip) => ip !== this.localIp && ip !== '0.0.0.0' && ip !== '127.0.0.1',
    );

    let index = 0;
    const inFlight = new Set();

    const pump = () => {
      while (inFlight.size < 32 && index < targets.length) {
        const ip = targets[index++];
        const task = this.sendPacket(ip, proto.SERVER_PORT, ping).finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
      }
    };
    pump();
  }

  // =========================================================================
  // outbound
  // =========================================================================

  _makePacket(type, payload, targetId = 'GLOBAL', extraData = null, msgId = null) {
    return proto.createPacket({
      type,
      senderId: this.deviceId,
      senderName: this.displayName,
      targetId,
      payload,
      extraData,
      msgId,
    });
  }

  sendPacket(ip, port, packet) {
    return new Promise((resolve) => {
      if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1') return resolve(false);
      const socket = net.createConnection({ host: ip, port: port || proto.SERVER_PORT });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_e) { /* ignore */ }
        resolve(ok);
      };

      socket.setTimeout(5000);
      socket.once('connect', () => {
        try {
          socket.end(proto.encodePacketFrame(packet), () => finish(true));
        } catch (_e) {
          finish(false);
        }
      });
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  }

  /** Stream an encrypted file to a peer. */
  sendFile(ip, port, headerPacket, filePath) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: ip, port: port || proto.SERVER_PORT });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_e) { /* ignore */ }
        resolve(ok);
      };

      socket.setTimeout(30 * 60 * 1000);
      socket.once('connect', async () => {
        try {
          socket.write(proto.encodeFrame(proto.MAGIC_FILE, Buffer.from(proto.packetToJson(headerPacket), 'utf8')));
          const result = await proto.encryptFileToStream(filePath, socket);
          if (result.ok) socket.end();
          finish(result.ok);
        } catch (_e) {
          finish(false);
        }
      });
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  }

  // =========================================================================
  // incoming packets
  // =========================================================================

  _shouldProcess(packet) {
    if (packet.senderId === this.deviceId) return false;
    if (this.processedMsgIds.has(packet.msgId)) return false;

    this.processedMsgIds.add(packet.msgId);
    this.processedOrder.push(packet.msgId);
    if (this.processedOrder.length > 2000) {
      const evict = this.processedOrder.shift();
      this.processedMsgIds.delete(evict);
    }
    return true;
  }

  _handleIncomingPacket(packet, senderIp) {
    if (!this._shouldProcess(packet)) return;
    this._watchdogRecord(this.watchdog.received, senderIp);

    switch (packet.type) {
      case proto.SignalType.PING: {
        const pong = this._makePacket(
          proto.SignalType.PONG,
          packet.payload,
          packet.senderId,
        );
        this.sendPacket(senderIp, proto.SERVER_PORT, pong);
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        break;
      }

      case proto.SignalType.PONG: {
        const sentAt = Number.parseInt(packet.payload, 10);
        const rtt = sentAt > 0 ? Math.max(1, Date.now() - sentAt) : -1;
        this._updatePeerHeartbeat(senderIp, packet.senderName, rtt);
        break;
      }

      case proto.SignalType.CHAT_MSG: {
        const now = Date.now();
        const isPrivate = packet.targetId !== 'GLOBAL' && !String(packet.targetId).startsWith('CHANNEL_');
        this.store.upsertMessage({
          id: packet.msgId,
          senderId: senderIp,
          senderName: packet.senderName,
          receiverId: isPrivate ? senderIp : 'GLOBAL',
          content: packet.payload,
          type: 'TEXT',
          mediaPath: null,
          fileSize: 0,
          timestamp: now,
          isOutgoing: false,
          status: 'RECEIVED',
          isStarred: false,
        });
        if (isPrivate) {
          this._bumpUnread(senderIp, now, packet.payload);
          const ack = this._makePacket(proto.SignalType.MSG_ACK, packet.msgId, packet.senderId);
          this.sendPacket(senderIp, proto.SERVER_PORT, ack);
        }
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        // Tell the UI exactly what just arrived. The renderer is often on a
        // different tab, so without this the message is received and stored but
        // nothing on screen changes until the user happens to visit that tab.
        this.lastIncoming = {
          id: packet.msgId,
          kind: 'text',
          chatId: isPrivate ? senderIp : 'GLOBAL',
          senderName: packet.senderName,
          preview: String(packet.payload || '').slice(0, 120),
          timestamp: now,
        };
        this._safeState('message');
        break;
      }

      case proto.SignalType.MSG_ACK: {
        this.store.setMessageStatus(packet.payload, 'DELIVERED');
        this._safeState('message-ack');
        break;
      }

      case proto.SignalType.MSG_READ: {
        this.store.markOutgoingMessagesAsRead(senderIp);
        this._safeState('message-read');
        break;
      }

      case proto.SignalType.FILE_HEADER: {
        // Header arrives on its own connection before the payload stream in
        // some clients; nothing to do beyond refreshing liveness.
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        break;
      }

      case proto.SignalType.CALL_INVITE: {
        const isVideo = packet.extraData === null ? true : packet.extraData === 'true';
        this.incomingCall = {
          callerId: packet.senderId,
          callerName: packet.senderName,
          peerIp: senderIp,
          isVideoCall: isVideo,
        };
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        this._safeState('incoming-call');
        break;
      }

      case proto.SignalType.CALL_ACCEPT: {
        const isVideo = packet.extraData === null
          ? !!(this.activeCall && this.activeCall.isVideoCall)
          : packet.extraData === 'true';
        this.activeCall = {
          callerId: packet.senderId,
          callerName: packet.senderName,
          peerIp: senderIp,
          isVideoCall: isVideo,
          outgoing: !!(this.activeCall && this.activeCall.outgoing),
        };
        this.media.setCallTargets([senderIp]);
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        this._safeState('call-accepted');
        break;
      }

      case proto.SignalType.CALL_DECLINE:
      case proto.SignalType.CALL_END: {
        this.incomingCall = null;
        this.activeCall = null;
        this.media.setCallTargets([]);
        this._safeState(packet.type === 'CALL_END' ? 'call-ended' : 'call-declined');
        break;
      }

      // The Android client sends a synthetic SDP/ICE exchange for its call
      // engine; the actual media rides on the dedicated UDP ports instead.
      case proto.SignalType.SDP_OFFER:
      case proto.SignalType.SDP_ANSWER:
      case proto.SignalType.ICE_CANDIDATE: {
        this._updatePeerHeartbeat(senderIp, packet.senderName, -1);
        break;
      }

      default:
        break;
    }
  }

  _bumpUnread(ip, time, snippet) {
    const existing = this.peers.get(ip) || this.store.getPeer(ip) || { unreadCount: 0 };
    this.store.upsertPeer(ip, {
      id: ip,
      ipAddress: ip,
      port: proto.SERVER_PORT,
      lastMessageTime: time,
      lastMessageSnippet: snippet,
      unreadCount: (existing.unreadCount || 0) + 1,
    });
    const peer = this.store.getPeer(ip);
    if (peer) this.peers.set(ip, peer);
  }

  _handleIncomingFile(filePath, header, senderIp) {
    if (header.senderId === this.deviceId) return;

    const ext = (path.extname(filePath) || '').toLowerCase();
    const type = classifyFile(ext);
    const now = Date.now();
    const isPrivate = header.targetId !== 'GLOBAL' && !String(header.targetId).startsWith('CHANNEL_');
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (_e) { /* ignore */ }

    this.store.upsertMessage({
      id: proto.uuid(),
      senderId: senderIp,
      senderName: header.senderName,
      receiverId: isPrivate ? senderIp : 'GLOBAL',
      content: path.basename(filePath),
      type,
      mediaPath: filePath,
      fileSize: size,
      timestamp: now,
      isOutgoing: false,
      status: 'RECEIVED',
      isStarred: false,
    });

    this.lastIncoming = {
      id: proto.uuid(),
      kind: 'file',
      chatId: isPrivate ? senderIp : 'GLOBAL',
      senderName: header.senderName,
      preview: path.basename(filePath),
      timestamp: now,
    };
    this._updatePeerHeartbeat(senderIp, header.senderName, -1);
    if (isPrivate) {
      this._bumpUnread(senderIp, now, `Sent a file: ${path.basename(filePath)}`);
    }
    this._safeState('file-received');
  }

  // =========================================================================
  // public actions (invoked from the renderer over IPC)
  // =========================================================================

  setDisplayName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    this.displayName = trimmed;
    this.store.setPref('custom_display_name', trimmed);
    if (this.mdns) this.mdns.updateDisplayName(trimmed);

    const ping = this._makePacket(proto.SignalType.PING, String(Date.now()));
    this.sendSignalBroadcast(ping);
    for (const [ip, peer] of this.peers) {
      if (ip !== this.localIp) this.sendPacket(ip, peer.port || proto.SERVER_PORT, ping);
    }
    this._safeState('display-name');
    return true;
  }

  setChannel(channel) {
    this.currentChannel = Math.min(99, Math.max(1, parseInt(channel, 10) || 1));
    this._safeState('channel');
    return this.currentChannel;
  }

  setAutoDelete(enabled) {
    this.autoDeleteOldMessages = !!enabled;
    this.store.setPref('auto_delete_old_messages', this.autoDeleteOldMessages);
    this._safeState('settings');
  }

  sendTextMessage(targetChatId, content) {
    const text = String(content || '').trim();
    if (!text) return false;

    const msgId = proto.uuid();
    const now = Date.now();
    const target = targetChatId || 'GLOBAL';

    this.store.upsertMessage({
      id: msgId,
      senderId: this.deviceId,
      senderName: this.displayName,
      receiverId: target,
      content: text,
      type: 'TEXT',
      mediaPath: null,
      fileSize: 0,
      timestamp: now,
      isOutgoing: true,
      status: 'SENDING',
      isStarred: false,
    });

    const packet = this._makePacket(proto.SignalType.CHAT_MSG, text, target, null, msgId);

    if (target === 'GLOBAL') {
      this.sendSignalBroadcast(packet);
      for (const [ip, peer] of this.peers) {
        if (ip === this.localIp) continue;
        this.sendPacket(ip, peer.port || proto.SERVER_PORT, packet);
      }
      this.store.setMessageStatus(msgId, 'SENT');
    } else {
      const peer = this.peers.get(target);
      const targetIp = peer ? peer.ipAddress : target;
      this.sendPacket(targetIp, proto.SERVER_PORT, packet).then((ok) => {
        this.store.setMessageStatus(msgId, ok ? 'SENT' : 'FAILED');
        this._safeState('message-status');
      });
    }

    this._safeState('message-sent');
    return true;
  }

  async sendMediaFile(targetChatId, filePath, type) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return { ok: false, reason: 'File not readable' };
    }

    const target = targetChatId || 'GLOBAL';
    const fileName = path.basename(filePath);
    const now = Date.now();

    this.store.upsertMessage({
      id: proto.uuid(),
      senderId: this.deviceId,
      senderName: this.displayName,
      receiverId: target,
      content: fileName,
      type: type || classifyFile(path.extname(fileName).toLowerCase()),
      mediaPath: filePath,
      fileSize: stat.size,
      timestamp: now,
      isOutgoing: true,
      status: 'SENDING',
      isStarred: false,
    });

    const header = this._makePacket(
      proto.SignalType.FILE_HEADER,
      fileName,
      target,
      String(stat.size),
    );

    let ok = false;
    if (target === 'GLOBAL') {
      const jobs = [];
      for (const [ip, peer] of this.peers) {
        if (ip === this.localIp) continue;
        jobs.push(this.sendFile(ip, peer.port || proto.SERVER_PORT, header, filePath));
      }
      const results = await Promise.all(jobs);
      ok = results.some(Boolean) || this.peers.size <= 1;
    } else {
      const peer = this.peers.get(target);
      const targetIp = peer ? peer.ipAddress : target;
      ok = await this.sendFile(targetIp, proto.SERVER_PORT, header, filePath);
    }

    this._safeState('file-sent');
    return { ok, fileName };
  }

  markChatAsRead(chatId) {
    if (!chatId || chatId === 'GLOBAL') return;
    this.store.markChatMessagesAsRead(chatId);
    const peer = this.peers.get(chatId) || this.store.getPeer(chatId);
    if (peer) this.peers.set(chatId, this.store.upsertPeer(chatId, { unreadCount: 0 }));

    const readPacket = this._makePacket(proto.SignalType.MSG_READ, 'READ_ALL', chatId);
    this.sendPacket(chatId, proto.SERVER_PORT, readPacket);
    this._safeState('chat-read');
  }

  toggleMessageStar(msgId, isStarred) {
    this.store.setMessageStar(msgId, isStarred);
    this._safeState('message-star');
  }

  clearMessages(chatId) {
    const n = this.store.clearMessages(chatId);
    this._safeState('messages-cleared');
    return n;
  }

  cleanUpOldMessagesNow() {
    const cutoff = Date.now() - MSG_RETENTION_MS;
    const n = this.store.deleteOldNonStarredMessages(cutoff);
    this._safeState('cleanup');
    return n;
  }

  _autoCleanup() {
    if (!this.autoDeleteOldMessages) return;
    const n = this.store.deleteOldNonStarredMessages(Date.now() - MSG_RETENTION_MS);
    if (n > 0) {
      console.log(`[repo] auto-cleaned ${n} messages older than 2 days`);
      this._safeState('cleanup');
    }
  }

  // -- walkie-talkie ------------------------------------------------------

  setTransmitting(value) {
    this.media.setTransmitting(!!value);
    this._safeState('transmitting');
  }

  // -- calls --------------------------------------------------------------

  initiateCall(peerIp, isVideoCall) {
    if (!peerIp) return false;
    this.activeCall = {
      callerId: this.deviceId,
      callerName: this.displayName,
      peerIp,
      isVideoCall: !!isVideoCall,
      outgoing: true,
    };
    this.callVideoEnabled = !!isVideoCall;
    this.media.setCallTargets([peerIp]);

    const invite = this._makePacket(
      proto.SignalType.CALL_INVITE,
      this.localIp,
      peerIp,
      String(!!isVideoCall),
    );
    this.sendPacket(peerIp, proto.SERVER_PORT, invite);

    // Mirror the Android client's SDP/ICE exchange so its call state machine
    // (ringing -> connected) advances. Media itself uses UDP :8890 / :8889.
    const sdpOffer = this._makePacket(proto.SignalType.SDP_OFFER, this._buildSdp(peerIp, false), peerIp);
    this.sendPacket(peerIp, proto.SERVER_PORT, sdpOffer);
    const candidate = this._makePacket(
      proto.SignalType.ICE_CANDIDATE,
      `candidate:1 1 UDP 2122260223 ${peerIp} ${proto.CALL_AUDIO_PORT} typ host`,
      peerIp,
    );
    this.sendPacket(peerIp, proto.SERVER_PORT, candidate);

    this._safeState('call-started');
    return true;
  }

  acceptIncomingCall() {
    const offer = this.incomingCall;
    if (!offer) return false;
    this.activeCall = {
      callerId: offer.callerId,
      callerName: offer.callerName,
      peerIp: offer.peerIp,
      isVideoCall: offer.isVideoCall,
      outgoing: false,
    };
    this.incomingCall = null;
    this.callVideoEnabled = offer.isVideoCall;
    this.media.setCallTargets([offer.peerIp]);

    const accept = this._makePacket(
      proto.SignalType.CALL_ACCEPT,
      this.localIp,
      offer.peerIp,
      String(!!offer.isVideoCall),
    );
    this.sendPacket(offer.peerIp, proto.SERVER_PORT, accept);

    const answer = this._makePacket(proto.SignalType.SDP_ANSWER, this._buildSdp(offer.peerIp, true), offer.peerIp);
    this.sendPacket(offer.peerIp, proto.SERVER_PORT, answer);
    const candidate = this._makePacket(
      proto.SignalType.ICE_CANDIDATE,
      `candidate:1 1 UDP 2122260223 ${offer.peerIp} ${proto.CALL_AUDIO_PORT} typ host`,
      offer.peerIp,
    );
    this.sendPacket(offer.peerIp, proto.SERVER_PORT, candidate);

    this._safeState('call-accepted');
    return true;
  }

  declineIncomingCall() {
    const offer = this.incomingCall;
    if (!offer) return false;
    this.incomingCall = null;
    this.sendPacket(
      offer.peerIp,
      proto.SERVER_PORT,
      this._makePacket(proto.SignalType.CALL_DECLINE, '', offer.peerIp),
    );
    this._safeState('call-declined');
    return true;
  }

  endCurrentCall() {
    const active = this.activeCall;
    this.activeCall = null;
    this.incomingCall = null;
    this.media.setCallTargets([]);
    if (active) {
      this.sendPacket(
        active.peerIp,
        proto.SERVER_PORT,
        this._makePacket(proto.SignalType.CALL_END, '', active.peerIp),
      );
    }
    this._safeState('call-ended');
  }

  _buildSdp(peerIp, isAnswer) {
    const sessionName = isAnswer ? 'CallEngineAnswer' : 'CallEngine';
    return [
      'v=0',
      `o=- ${Date.now()} 2 IN IP4 ${peerIp}`,
      `s=${sessionName}`,
      't=0 0',
      `m=audio ${proto.CALL_AUDIO_PORT} RTP/AVP 0`,
      `m=video ${proto.CALL_VIDEO_PORT} RTP/AVP 26`,
      '',
    ].join('\r\n');
  }

  setCallMicMuted(muted) {
    this.callMicMuted = !!muted;
    this._safeState('call-mic');
  }

  setCallVideoEnabled(enabled) {
    this.callVideoEnabled = !!enabled;
    this._safeState('call-video');
  }

  // =========================================================================
  // snapshot for the UI
  // =========================================================================

  snapshot() {
    return {
      deviceId: this.deviceId,
      displayName: this.displayName,
      localIp: this.localIp,
      ssid: this.ssid,
      interfaceName: this.interfaceName,
      broadcastAddress: this.broadcastAddress,
      status: this.connectionStatus(),
      currentChannel: this.currentChannel,
      autoDeleteOldMessages: this.autoDeleteOldMessages,
      peers: this.orderedPeers(),
      receivedDir: this.store.receivedDir,
      incomingCall: this.incomingCall,
      activeCall: this.activeCall,
      callMicMuted: this.callMicMuted,
      callVideoEnabled: this.callVideoEnabled,
      transmitting: this.media.transmitting,
      lastIncoming: this.lastIncoming,
      ports: {
        tcp: proto.SERVER_PORT,
        udpSignal: proto.UDP_BROADCAST_PORT,
        udpAudio: proto.UDP_AUDIO_PORT,
        callAudio: proto.CALL_AUDIO_PORT,
        callVideo: proto.CALL_VIDEO_PORT,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
const VIDEO_EXT = ['.mp4', '.mkv', '.3gp', '.webm', '.avi', '.mov'];
const VOICE_EXT = ['.ogg', '.aac', '.m4a', '.wav', '.mp3', '.3gp', '.amr'];

function classifyFile(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXT.includes(e)) return 'IMAGE';
  if (VIDEO_EXT.includes(e)) return 'VIDEO';
  if (VOICE_EXT.includes(e)) return 'VOICE_NOTE';
  return 'FILE';
}

/** Strip any directory component so a remote peer cannot choose our path. */
function sanitizeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'received.bin';
}

function uniquePath(dir, fileName) {
  let target = path.join(dir, fileName);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let n = 1;
  do {
    target = path.join(dir, `${stem}_${n}${ext}`);
    n += 1;
  } while (fs.existsSync(target) && n < 1000);
  return target;
}

module.exports = {
  P2PRepository,
  ConnectionStatus,
  classifyFile,
  sanitizeFileName,
  uniquePath,
  AVATAR_COLORS,
};