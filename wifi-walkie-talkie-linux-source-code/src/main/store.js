'use strict';
/**
 * store.js — Durable state for peers and messages.
 *
 * Stands in for the Room database (AppDatabase/ChatDao) of the Android app.
 * State is kept in memory and flushed atomically to a JSON file inside the
 * application user-data directory, with a write-behind debounce so that high
 * message rates never block the network threads.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const FLUSH_DELAY_MS = 400;

function defaultPeer(id) {
  return {
    id,
    displayName: `Peer-${id}`,
    ipAddress: id,
    port: 8888,
    lastSeen: Date.now(),
    isOnline: true,
    channel: 1,
    avatarColor: 0xff3b82f6,
    rttMs: -1,
    isUnreachable: false,
    lastMessageTime: 0,
    lastMessageSnippet: null,
    unreadCount: 0,
  };
}

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'walkie-data.json');
    this.receivedDir = path.join(userDataDir, 'received');
    this.prefs = {
      custom_display_name: null,
      auto_delete_old_messages: true,
    };
    this.peers = new Map();
    /** @type {Map<string, object>} message id -> message */
    this.messages = new Map();
    this._flushTimer = null;
    this._dirty = false;
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.mkdirSync(this.receivedDir, { recursive: true });
    } catch (e) {
      console.error('[store] cannot create data directories:', e.message);
    }

    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (_e) {
      raw = null; // first run
    }

    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.prefs) Object.assign(this.prefs, data.prefs);
        for (const peer of data.peers || []) {
          if (peer && peer.id) this.peers.set(peer.id, Object.assign(defaultPeer(peer.id), peer));
        }
        for (const msg of data.messages || []) {
          if (msg && msg.id) this.messages.set(msg.id, msg);
        }
        console.log(`[store] loaded ${this.peers.size} peers, ${this.messages.size} messages`);
      } catch (e) {
        console.error('[store] corrupt store, starting fresh:', e.message);
        this.peers.clear();
        this.messages.clear();
      }
    }
    return this;
  }

  _markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const payload = {
      schema: SCHEMA_VERSION,
      prefs: this.prefs,
      peers: Array.from(this.peers.values()),
      messages: Array.from(this.messages.values()),
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] flush failed:', e.message);
    }
  }

  // -- preferences ----------------------------------------------------------

  getPref(key) {
    return this.prefs[key];
  }

  setPref(key, value) {
    this.prefs[key] = value;
    this._markDirty();
  }

  // -- peers ----------------------------------------------------------------

  getPeer(id) {
    return this.peers.get(id) || null;
  }

  upsertPeer(id, patch) {
    const existing = this.peers.get(id) || defaultPeer(id);
    const next = Object.assign({}, existing, patch, { id });
    this.peers.set(id, next);
    this._markDirty();
    return next;
  }

  deletePeer(id) {
    if (this.peers.delete(id)) this._markDirty();
  }

  allPeers() {
    return Array.from(this.peers.values());
  }

  // -- messages -------------------------------------------------------------

  upsertMessage(message) {
    const existing = this.messages.get(message.id);
    const next = existing ? Object.assign({}, existing, message) : message;
    this.messages.set(message.id, next);
    this._markDirty();
    return next;
  }

  getMessage(id) {
    return this.messages.get(id) || null;
  }

  setMessageStatus(id, status) {
    const msg = this.messages.get(id);
    if (!msg || msg.status === status) return null;
    const next = Object.assign({}, msg, { status });
    this.messages.set(id, next);
    this._markDirty();
    return next;
  }

  setMessageStar(id, isStarred) {
    const msg = this.messages.get(id);
    if (!msg) return null;
    const next = Object.assign({}, msg, { isStarred: !!isStarred });
    this.messages.set(id, next);
    this._markDirty();
    return next;
  }

  /** Chat list for a 1-on-1 conversation (mirrors ChatDao.getMessagesForChat). */
  getMessagesForChat(chatId) {
    const out = [];
    const isGlobal = (v) => v === 'GLOBAL';
    for (const msg of this.messages.values()) {
      if (isGlobal(msg.senderId) || isGlobal(msg.receiverId)) continue;
      if (String(msg.receiverId).startsWith('CHANNEL_')) continue;
      // Mirrors the Android query:
      //   (receiverId = :chatId AND senderId != 'GLOBAL')
      //   OR (senderId = :chatId AND receiverId != 'GLOBAL')
      //
      // The `!=` tests are against the literal 'GLOBAL', NOT against chatId.
      // Incoming private messages are stored with senderId == receiverId ==
      // senderIp (exactly as Android does), so comparing them against chatId
      // made every incoming message look like a self-message and silently
      // hid the entire received conversation.
      const match =
        (msg.receiverId === chatId && !isGlobal(msg.senderId)) ||
        (msg.senderId === chatId && !isGlobal(msg.receiverId));
      if (match) out.push(msg);
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** Broadcast / channel conversation (mirrors getGlobalMessages). */
  getGlobalMessages() {
    const out = [];
    for (const msg of this.messages.values()) {
      if (msg.receiverId === 'GLOBAL' || String(msg.receiverId).startsWith('CHANNEL_')) {
        out.push(msg);
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  markChatMessagesAsRead(chatId) {
    let changed = 0;
    for (const msg of this.messages.values()) {
      if (msg.isOutgoing) continue;
      if (msg.receiverId !== chatId && msg.senderId !== chatId) continue;
      if (msg.status === 'READ') continue;
      msg.status = 'READ';
      changed += 1;
    }
    if (changed) this._markDirty();
    return changed;
  }

  markOutgoingMessagesAsRead(chatId) {
    let changed = 0;
    for (const msg of this.messages.values()) {
      if (!msg.isOutgoing) continue;
      if (msg.receiverId !== chatId && msg.senderId !== chatId) continue;
      if (msg.status === 'READ') continue;
      msg.status = 'READ';
      changed += 1;
    }
    if (changed) this._markDirty();
    return changed;
  }

  clearMessages(chatId) {
    const toDelete = [];
    for (const [id, msg] of this.messages) {
      if (msg.receiverId === chatId || msg.senderId === chatId) toDelete.push(id);
    }
    for (const id of toDelete) this.messages.delete(id);
    if (toDelete.length) this._markDirty();
    return toDelete.length;
  }

  /** Delete non-starred messages older than `cutoff` (2 days, like Android). */
  deleteOldNonStarredMessages(cutoff) {
    const toDelete = [];
    for (const [id, msg] of this.messages) {
      if (!msg.isStarred && msg.timestamp < cutoff) toDelete.push(id);
    }
    for (const id of toDelete) this.messages.delete(id);
    if (toDelete.length) this._markDirty();
    return toDelete.length;
  }

  markStalePeersOffline(cutoff) {
    let changed = false;
    for (const peer of this.peers.values()) {
      if (peer.lastSeen < cutoff && peer.isOnline) {
        peer.isOnline = false;
        peer.isUnreachable = true;
        peer.rttMs = -1;
        changed = true;
      }
    }
    if (changed) this._markDirty();
  }

  close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.flush();
  }
}

module.exports = { Store, defaultPeer, SCHEMA_VERSION };