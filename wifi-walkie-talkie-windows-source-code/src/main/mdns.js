'use strict';
/**
 * mdns.js — Minimal, dependency-free DNS-SD (mDNS) advertiser + browser.
 *
 * Advertises and browses `_walkietalkie._tcp.local`, matching the service
 * used by the Android client (com.example.network.NsdHelper):
 *
 *   instance : WT-<displayName>._walkietalkie._tcp.local
 *   SRV      : <hostname>.local. :8888
 *   TXT      : displayName=<name>   model=<model>
 *   A        : <local ipv4>
 *
 * Implemented directly on dgram/UDP so the AppImage needs no native modules.
 */

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;

const CLASS_IN = 1;
const CLASS_CACHE_FLUSH = 0x8000;
const CLASS_MASK = 0x7fff;

const TTL = 120;

// ---------------------------------------------------------------------------
// DNS wire encoding
// ---------------------------------------------------------------------------

/** Escape-aware label split (a literal dot in a label must be backslash escaped). */
function splitLabels(name) {
  const labels = [];
  let current = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '\\' && i + 1 < name.length) {
      current += name[i + 1];
      i++;
      continue;
    }
    if (ch === '.') {
      labels.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) labels.push(current);
  return labels.filter((l) => l.length > 0);
}

function escapeLabel(label) {
  return String(label).replace(/([\\.])/g, '\\$1');
}

function encodeName(name) {
  const parts = [];
  for (const label of splitLabels(name)) {
    const buf = Buffer.from(label, 'utf8');
    if (buf.length > 63) buf.fill(buf.subarray(0, 63), 63);
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Decode a (possibly compressed) name; returns the name and the next offset. */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = null;
  let hops = 0;

  for (;;) {
    if (pos >= buf.length) return { name: labels.join('.'), offset: buf.length };
    const len = buf.readUInt8(pos);
    if (len === 0) {
      pos += 1;
      if (next === null) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return { name: labels.join('.'), offset: buf.length };
      const ptr = ((len & 0x3f) << 8) | buf.readUInt8(pos + 1);
      if (next === null) next = pos + 2;
      pos = ptr;
      hops += 1;
      if (hops > 16) return { name: labels.join('.'), offset: next };
      continue;
    }
    const start = pos + 1;
    const end = start + len;
    if (end > buf.length) return { name: labels.join('.'), offset: buf.length };
    labels.push(buf.subarray(start, end).toString('utf8'));
    pos = end;
  }
  return { name: labels.join('.'), offset: next === null ? pos : next };
}

function encodeQuestion(name, qtype) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(qtype, 0);
  head.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([encodeName(name), head]);
}

function buildRecord({ name, type, ttl, cacheFlush = true, rdata }) {
  const cls = CLASS_IN | (cacheFlush ? CLASS_CACHE_FLUSH : 0);
  const head = Buffer.alloc(8);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cls, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 6);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function rdataPtr(target) {
  return encodeName(target);
}

function rdataSrv(priority, weight, port, target) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(priority, 0);
  head.writeUInt16BE(weight, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function rdataTxt(entries) {
  const parts = [];
  for (const [k, v] of Object.entries(entries)) {
    const raw = Buffer.from(`${k}=${v}`, 'utf8');
    const entry = raw.length > 255 ? Buffer.concat([raw.subarray(0, 255)]) : raw;
    parts.push(Buffer.from([entry.length]), entry);
  }
  if (parts.length === 0) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function rdataA(ip) {
  const parts = String(ip).split('.').map((n) => parseInt(n, 10) & 255);
  return Buffer.from(parts);
}

function parseTxt(rdata) {
  const out = {};
  let i = 0;
  while (i < rdata.length) {
    const len = rdata.readUInt8(i);
    i += 1;
    if (len === 0) continue;
    if (i + len > rdata.length) break;
    const entry = rdata.subarray(i, i + len).toString('utf8');
    i += len;
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    else out[entry] = '';
  }
  return out;
}

/** Parse a DNS message into { questions, records }. */
function parseMessage(buf) {
  const msg = { questions: [], records: [] };
  if (buf.length < 12) return msg;

  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);
  let offset = 12;

  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { name, offset: next } = decodeName(buf, offset);
    if (next + 4 > buf.length) return msg;
    msg.questions.push({ name, qtype: buf.readUInt16BE(next), qclass: buf.readUInt16BE(next + 2) & CLASS_MASK });
    offset = next + 4;
  }

  const total = anCount + nsCount + arCount;
  for (let i = 0; i < total && offset < buf.length; i++) {
    const { name, offset: afterName } = decodeName(buf, offset);
    if (afterName + 10 > buf.length) return msg;
    const type = buf.readUInt16BE(afterName);
    const cls = buf.readUInt16BE(afterName + 2) & CLASS_MASK;
    const ttl = buf.readUInt32BE(afterName + 4);
    const rdlength = buf.readUInt16BE(afterName + 8);
    const rdataStart = afterName + 10;
    const rdataEnd = rdataStart + rdlength;
    if (rdataEnd > buf.length) return msg;
    const rdata = buf.subarray(rdataStart, rdataEnd);

    const record = { name, type, cls, ttl, rdata };
    if (type === TYPE_PTR && cls === CLASS_IN) {
      const target = decodeName(buf, rdataStart);
      record.target = target.name;
    } else if (type === TYPE_SRV && cls === CLASS_IN) {
      const target = decodeName(buf, rdataStart + 6);
      record.priority = rdata.readUInt16BE(0);
      record.weight = rdata.readUInt16BE(2);
      record.port = rdata.readUInt16BE(4);
      record.target = target.name;
    } else if (type === TYPE_TXT && cls === CLASS_IN) {
      record.txt = parseTxt(rdata);
    } else if (type === TYPE_A && cls === CLASS_IN && rdlength === 4) {
      record.address = [0, 1, 2, 3].map((n) => rdata.readUInt8(n)).join('.');
    }
    msg.records.push(record);
    offset = rdataEnd;
  }
  return msg;
}

function buildMessage(flags, questions = [], records = []) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(flags, 2);
  head.writeUInt16BE(questions.length, 4);
  head.writeUInt16BE(records.length, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  return Buffer.concat([
    head,
    ...questions.map((q) => encodeQuestion(q.name, q.qtype)),
    ...records,
  ]);
}

// ---------------------------------------------------------------------------
// MdnsService
// ---------------------------------------------------------------------------

class MdnsService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.serviceType   e.g. '_walkietalkie._tcp'
   * @param {number} opts.port
   * @param {string} opts.displayName
   * @param {string} opts.model
   * @param {string} opts.address       local IPv4 to publish
   */
  constructor(opts) {
    super();
    this.serviceType = opts.serviceType;
    this.port = opts.port;
    this.displayName = opts.displayName;
    this.model = opts.model || 'Linux';
    this.address = opts.address;
    this.hostname = sanitizeHostname(opts.hostname || os.hostname());

    this.instanceLabel = 'WT-' + this.displayName;
    this.serviceName = escapeLabel(this.instanceLabel);
    this.fqdn = `${this.serviceName}.${this.serviceType}.local`;
    this.typeName = `${this.serviceType}.local`;
    this.hostTarget = `${this.hostname}.local`;

    this.socket = null;
    this.timerAnnounce = null;
    this.timerQuery = null;
    this.timerPrune = null;
    this.running = false;
    this.conflictCount = 0;

    /** instanceName -> { srv, txt, a, updatedAt } */
    this.resolved = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.socket.on('error', (err) => this.emit('error', err));

    this.socket.bind(MDNS_PORT, () => {
      try {
        // Best effort multicast membership (2 joins for interface redundancy).
        const iface = this._bindInterfaceName();
        if (iface) this.socket.addMembership(MDNS_ADDR, iface);
        this.socket.setMulticastTTL(255);
        this.socket.setMulticastLoopback(true);
      } catch (_e) { /* some networks forbid this; broadcast queries still work */ }

      this.emit('ready');
      this._announce();
      this._queryAll();

      this.timerAnnounce = setInterval(() => this._announce(), 45000);
      this.timerQuery = setInterval(() => this._queryAll(), 30000);
      this.timerPrune = setInterval(() => this._prune(), 15000);
      if (this.timerAnnounce.unref) this.timerAnnounce.unref();
      if (this.timerQuery.unref) this.timerQuery.unref();
      if (this.timerPrune.unref) this.timerPrune.unref();
    });
  }

  _bindInterfaceName() {
    try {
      const osIfaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(osIfaces)) {
        for (const addr of addrs || []) {
          if ((addr.family === 'IPv4' || addr.family === 4) && addr.address === this.address) return name;
        }
      }
    } catch (_e) { /* ignore */ }
    return null;
  }

  stop() {
    this.running = false;
    if (this.timerAnnounce) clearInterval(this.timerAnnounce);
    if (this.timerQuery) clearInterval(this.timerQuery);
    if (this.timerPrune) clearInterval(this.timerPrune);
    if (this.socket) {
      try { this._sendGoodbye(); } catch (_e) { /* ignore */ }
      try { this.socket.close(); } catch (_e) { /* ignore */ }
      this.socket = null;
    }
  }

  /** Change the advertised display name (re-registers the instance). */
  updateDisplayName(displayName) {
    if (!displayName || displayName === this.displayName) return;
    this._sendGoodbye();
    this.displayName = displayName;
    this.instanceLabel = 'WT-' + displayName;
    this.serviceName = escapeLabel(this.instanceLabel);
    this.fqdn = `${this.serviceName}.${this.serviceType}.local`;
    this._announce();
  }

  updateAddress(address) {
    if (!address || address === this.address) return;
    this.address = address;
  }

  // -- advertising ----------------------------------------------------------

  _serviceRecords(ttl) {
    return [
      buildRecord({ name: this.fqdn, type: TYPE_SRV, ttl, rdata: rdataSrv(0, 0, this.port, this.hostTarget) }),
      buildRecord({ name: this.fqdn, type: TYPE_TXT, ttl, rdata: rdataTxt({ displayName: this.displayName, model: this.model }) }),
      buildRecord({ name: this.hostTarget, type: TYPE_A, ttl, rdata: rdataA(this.address) }),
    ];
  }

  _ptrRecord(ttl) {
    return buildRecord({ name: this.typeName, type: TYPE_PTR, ttl, rdata: rdataPtr(this.fqdn) });
  }

  _send(buf, multicast = true) {
    if (!this.socket) return;
    if (multicast) {
      this.socket.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDR, () => {});
    }
    // Also blast the subnet broadcast address: many Wi-Fi APs drop multicast.
    const iface = this._bindInterfaceName();
    let bcast = null;
    try {
      const osIfaces = os.networkInterfaces();
      for (const addrs of Object.values(osIfaces)) {
        for (const addr of addrs || []) {
          if ((addr.family === 'IPv4' || addr.family === 4) && addr.address === this.address) {
            bcast = addr.broadcast || null;
          }
        }
      }
    } catch (_e) { /* ignore */ }
    if (bcast && iface) {
      try { this.socket.send(buf, 0, buf.length, MDNS_PORT, bcast, () => {}); } catch (_e) { /* ignore */ }
    }
  }

  /** Unsolicted announcement of our service (flags: response + authoritative). */
  _announce() {
    if (!this.running || !this.address) return;
    const records = [this._ptrRecord(TTL), ...this._serviceRecords(TTL)];
    const msg = buildMessage(0x8400, [], records);
    this._send(msg);
    this.emit('announced', { instance: this.fqdn, displayName: this.displayName });
  }

  /** TTL=0 goodbye packets so peers drop us promptly on shutdown/rename. */
  _sendGoodbye() {
    if (!this.socket || !this.address) return;
    const records = [this._ptrRecord(0), ...this._serviceRecords(0)];
    this._send(buildMessage(0x8400, [], records));
  }

  // -- browsing -------------------------------------------------------------

  _queryAll() {
    if (!this.running) return;
    const msg = buildMessage(0x0000, [
      { name: this.typeName, qtype: TYPE_PTR },
      { name: this.typeName, qtype: TYPE_ANY },
    ]);
    this._send(msg);
  }

  _onMessage(msg, rinfo) {
    if (msg.length < 12) return;
    const isResponse = (msg.readUInt16BE(2) & 0x8000) !== 0;
    const parsed = parseMessage(msg);

    if (isResponse) {
      this._handleResponse(parsed, rinfo);
    } else {
      this._handleQuery(parsed, rinfo);
    }
  }

  _handleQuery(parsed, _rinfo) {
    if (!this.running || !this.address) return;
    const wants = parsed.questions.some(
      (q) => q.qtype === TYPE_PTR || q.qtype === TYPE_ANY || q.qclass === 255,
    );
    if (!wants) return;

    const names = new Set(parsed.questions.map((q) => q.name.toLowerCase()));
    const typeQ = names.has(this.typeName.toLowerCase());
    const instanceQ = names.has(this.fqdn.toLowerCase());
    const hostQ = names.has(this.hostTarget.toLowerCase());

    // Known-answer suppression is skipped deliberately: replies are tiny.
    if (typeQ) {
      const records = [this._ptrRecord(TTL), ...this._serviceRecords(TTL)];
      this._send(buildMessage(0x8400, [], records));
    } else if (instanceQ) {
      const records = this._serviceRecords(TTL);
      this._send(buildMessage(0x8400, [], records));
    } else if (hostQ) {
      const a = buildRecord({ name: this.hostTarget, type: TYPE_A, ttl: TTL, rdata: rdataA(this.address) });
      this._send(buildMessage(0x8400, [], [a]));
    }
  }

  _handleResponse(parsed, rinfo) {
    for (const rec of parsed.records) {
      if (rec.type === TYPE_PTR && rec.name.toLowerCase() === this.typeName.toLowerCase()) {
        if (!rec.target) continue;
        if (rec.target.toLowerCase() === this.fqdn.toLowerCase()) {
          // Somebody else claimed our instance name -> rename and re-announce.
          this._handleNameConflict();
          continue;
        }
        const key = rec.target.toLowerCase();
        if (!this.resolved.has(key)) {
          this.resolved.set(key, { srv: null, txt: null, address: null, updatedAt: 0 });
        }
        this.resolved.get(key).ptrAt = Date.now();
      } else if (rec.type === TYPE_SRV) {
        const key = rec.name.toLowerCase();
        if (!rec.target) continue;
        if (key === this.fqdn.toLowerCase()) {
          this._handleNameConflict();
          continue;
        }
        const entry = this._ensure(key);
        entry.srv = { host: rec.target, port: rec.port };
        entry.updatedAt = Date.now();
      } else if (rec.type === TYPE_TXT) {
        const key = rec.name.toLowerCase();
        if (key === this.fqdn.toLowerCase()) {
          this._handleNameConflict();
          continue;
        }
        const entry = this._ensure(key);
        entry.txt = rec.txt || {};
        entry.updatedAt = Date.now();
      } else if (rec.type === TYPE_A) {
        const key = rec.name.toLowerCase();
        for (const entry of this.resolved.values()) {
          if (entry.srv && entry.srv.host.toLowerCase() === key) {
            entry.address = rec.address;
            entry.updatedAt = Date.now();
          }
        }
      }
    }

    for (const [key, entry] of this.resolved) {
      if (entry.srv && entry.address) {
        this._emitResolved(key, entry, rinfo);
      }
    }
  }

  _ensure(key) {
    if (!this.resolved.has(key)) {
      this.resolved.set(key, { srv: null, txt: null, address: null, updatedAt: 0 });
    }
    return this.resolved.get(key);
  }

  _emitResolved(key, entry, _rinfo) {
    const instanceLabel = key.split(`.${this.serviceType}.`)[0];
    const displayName =
      (entry.txt && entry.txt.displayName) ||
      instanceLabel.replace(/^WT-/, '').replace(/\\\./g, '.');
    const model = (entry.txt && entry.txt.model) || 'unknown';

    // A record from the same host as us means our own advertisement.
    if (entry.address === this.address) return;

    this.emit('peer', {
      serviceName: key,
      instanceLabel,
      displayName,
      model,
      host: entry.srv.host,
      address: entry.address,
      port: entry.srv.port,
      updatedAt: Date.now(),
    });
  }

  _handleNameConflict() {
    this.conflictCount += 1;
    const suffix = ` (${this.conflictCount + 1})`;
    const nextLabel = 'WT-' + this.displayName + suffix;
    this.emit('conflict', { previous: this.fqdn, next: nextLabel });
    this.instanceLabel = nextLabel;
    this.serviceName = escapeLabel(nextLabel);
    this.fqdn = `${this.serviceName}.${this.serviceType}.local`;
    this._announce();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this.resolved) {
      const last = Math.max(entry.updatedAt || 0, entry.ptrAt || 0);
      if (now - last > (TTL * 1000 * 4)) {
        this.resolved.delete(key);
        this.emit('peerLost', { serviceName: key });
      }
    }
  }
}

function sanitizeHostname(name) {
  const cleaned = String(name || 'walkie-talkie').replace(/[^A-Za-z0-9-]/g, '-').replace(/-{2,}/g, '-');
  return cleaned || 'walkie-talkie';
}

module.exports = {
  MdnsService,
  encodeName,
  decodeName,
  parseMessage,
  buildMessage,
  splitLabels,
  MDNS_ADDR,
  MDNS_PORT,
  TYPE_A,
  TYPE_PTR,
  TYPE_TXT,
  TYPE_SRV,
  TYPE_ANY,
  TTL,
};