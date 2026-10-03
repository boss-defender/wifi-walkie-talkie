'use strict';
/**
 * protocol.js — Wire protocol for Wi-Fi Walkie-Talkie P2P.
 *
 * Byte-for-byte compatible with the Android implementation:
 *   com.example.network.P2PPacket
 *   com.example.network.LocalP2PServer
 *   com.example.network.BinaryStreamRelay
 *
 * Frame layout on TCP :8888
 *   [1 byte magic][4 byte big-endian length][length bytes UTF-8 JSON]
 *     magic 0x01 -> control/signal packet
 *     magic 0x02 -> file header packet, immediately followed by the
 *                   encrypted file payload (16 byte IV + AES-256-CTR stream)
 */

const crypto = require('crypto');

const MAGIC_PACKET = 0x01;
const MAGIC_FILE = 0x02;

const SERVER_PORT = 8888;
const UDP_BROADCAST_PORT = 8887;
const UDP_AUDIO_PORT = 9999;
const CALL_VIDEO_PORT = 8889;
const CALL_AUDIO_PORT = 8890;

const MULTICAST_IP = '239.255.0.1';

const SAMPLE_RATE = 16000;

/** mDNS service type advertised by every node. */
const SERVICE_TYPE = '_walkietalkie._tcp';

const SignalType = {
  CHAT_MSG: 'CHAT_MSG',
  MSG_ACK: 'MSG_ACK',
  MSG_READ: 'MSG_READ',
  FILE_HEADER: 'FILE_HEADER',
  FILE_CHUNK: 'FILE_CHUNK',
  CALL_INVITE: 'CALL_INVITE',
  CALL_ACCEPT: 'CALL_ACCEPT',
  CALL_DECLINE: 'CALL_DECLINE',
  CALL_END: 'CALL_END',
  SDP_OFFER: 'SDP_OFFER',
  SDP_ANSWER: 'SDP_ANSWER',
  ICE_CANDIDATE: 'ICE_CANDIDATE',
  PING: 'PING',
  PONG: 'PONG',
};

const SIGNAL_TYPE_SET = new Set(Object.values(SignalType));

/**
 * AES-256-CTR key for the direct binary stream relay.
 *
 * The Android app derives it by UTF-8 encoding
 * "P2P_TACTICAL_DIRECT_BINARY_KEY" (30 bytes) and zero-padding into a
 * 32 byte buffer. We reproduce that byte for byte so files exchanged
 * between Android and Linux clients decrypt correctly.
 */
const DIRECT_STREAM_KEY = (() => {
  const raw = Buffer.from('P2P_TACTICAL_DIRECT_BINARY_KEY', 'utf8');
  const key = Buffer.alloc(32);
  raw.copy(key, 0, 0, Math.min(raw.length, 32));
  return key;
})();

function uuid() {
  return crypto.randomUUID();
}

/** Build a P2P packet. Mirrors the Kotlin data class exactly. */
function createPacket({
  type,
  senderId,
  senderName,
  targetId = 'GLOBAL',
  payload = '',
  extraData = null,
  msgId = null,
}) {
  if (!SIGNAL_TYPE_SET.has(type)) {
    throw new Error(`Unknown signal type: ${type}`);
  }
  const packet = {
    type,
    senderId,
    senderName,
    targetId,
    payload,
    msgId: msgId || uuid(),
  };
  if (extraData !== null && extraData !== undefined) {
    packet.extraData = String(extraData);
  }
  return packet;
}

function packetToJson(packet) {
  return JSON.stringify(packet);
}

/** Parse a JSON control packet. Returns null on malformed input (same as Android). */
function packetFromJson(text) {
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') return null;
    if (!SIGNAL_TYPE_SET.has(json.type)) return null;
    if (typeof json.senderId !== 'string' || typeof json.senderName !== 'string') return null;
    return {
      type: json.type,
      senderId: json.senderId,
      senderName: json.senderName,
      targetId: typeof json.targetId === 'string' ? json.targetId : 'GLOBAL',
      payload: typeof json.payload === 'string' ? json.payload : '',
      extraData: json.extraData === undefined || json.extraData === null ? null : String(json.extraData),
      msgId: typeof json.msgId === 'string' && json.msgId ? json.msgId : uuid(),
    };
  } catch (_e) {
    return null;
  }
}

/** Encode a whole frame: magic + length + payload. */
function encodeFrame(magic, payloadBuffer) {
  const frame = Buffer.allocUnsafe(5 + payloadBuffer.length);
  frame.writeUInt8(magic, 0);
  frame.writeUInt32BE(payloadBuffer.length, 1);
  payloadBuffer.copy(frame, 5);
  return frame;
}

function encodePacketFrame(packet) {
  return encodeFrame(MAGIC_PACKET, Buffer.from(packetToJson(packet), 'utf8'));
}

/**
 * Incremental TCP frame reader.
 * push() may be called with arbitrary chunk boundaries.
 */
class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.rawHandler = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    if (this.rawHandler) {
      this.rawHandler(chunk);
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 5) return;
      const magic = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32BE(1);
      if (length > 500000) {
        // Protocol violation / desync — drop the connection framing.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 5 + length) return;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this.onFrame(magic, payload);
    }
  }

  /**
   * Hand back (and forget) every byte that arrived after the last complete
   * frame. A file transfer must consume these before the socket is switched
   * over to raw-stream mode, otherwise they would be lost.
   */
  takeRemainder() {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }

  /**
   * Switch this reader into raw mode. Every subsequent push() is forwarded
   * verbatim instead of being parsed as frames.
   *
   * Keeping the same single 'data' listener for the whole connection avoids
   * tearing down and re-arming the socket's flow state mid-transfer, which is
   * where stream truncation bugs come from.
   */
  setRawHandler(fn) {
    this.rawHandler = fn;
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Incremental AES-256-CTR decryptor for file payloads.
 *
 * Java's "AES/CTR/NoPadding" and Node's "aes-256-ctr" are the same
 * construction — a 128 bit big endian counter added to each 16 byte block —
 * so streams produced by either platform interop cleanly.
 *
 * Callers push bytes in with write() and finish with finalize(). There is no
 * stream/listener plumbing involved, so the caller stays in full control of
 * exactly which socket chunks are handed over.
 */
class FileDecryptStream {
  constructor(onProgress) {
    this.iv = Buffer.alloc(16);
    this.ivRead = 0;
    this.decryptor = null;
    this.chunks = [];
    this.total = 0;
    this.finished = false;
    this.onProgress = onProgress || null;
  }

  write(chunk) {
    if (this.finished || !chunk || chunk.length === 0) return;
    let data = chunk;

    if (this.ivRead < 16) {
      const need = 16 - this.ivRead;
      if (data.length < need) {
        data.copy(this.iv, this.ivRead, 0, data.length);
        this.ivRead += data.length;
        return;
      }
      data.copy(this.iv, this.ivRead, 0, need);
      this.ivRead = 16;
      data = data.subarray(need);
      if (data.length === 0) return;
    }

    // The cipher may only be constructed once the IV has been fully read,
    // because Node copies the IV buffer at construction time.
    if (!this.decryptor) {
      this.decryptor = crypto.createDecipheriv('aes-256-ctr', DIRECT_STREAM_KEY, this.iv);
    }

    const plain = this.decryptor.update(data);
    if (plain.length > 0) {
      this.chunks.push(plain);
      this.total += plain.length;
    }
    if (this.onProgress) this.onProgress(this.total);
  }

  /** Flush, write everything to disk and resolve with the outcome. */
  finalize(destPath, expectedLength) {
    if (this.finished) return Promise.resolve({ ok: false, reason: 'already finished' });
    this.finished = true;

    if (this.ivRead < 16) {
      return this._reject(destPath, 'incomplete IV header');
    }

    try {
      if (this.decryptor) {
        const tail = this.decryptor.final();
        if (tail && tail.length > 0) {
          this.chunks.push(tail);
          this.total += tail.length;
        }
      }
    } catch (e) {
      return this._reject(destPath, 'final: ' + e.message);
    }

    if (expectedLength > 0 && this.total !== expectedLength) {
      return this._reject(
        destPath,
        `size mismatch: expected ${expectedLength}, received ${this.total}`,
      );
    }

    const fs = require('fs');
    return new Promise((resolve) => {
      try {
        const ws = fs.createWriteStream(destPath);
        ws.on('error', () => resolve({ ok: false, reason: 'write error' }));
        ws.on('close', () => resolve({ ok: true, bytes: this.total }));
        for (const part of this.chunks) ws.write(part);
        ws.end();
      } catch (e) {
        resolve({ ok: false, reason: 'open dest: ' + e.message });
      }
    });
  }

  _reject(destPath, reason) {
    try { require('fs').unlinkSync(destPath); } catch (_e) { /* ignore */ }
    return Promise.resolve({ ok: false, reason });
  }
}

/**
 * Convenience wrapper: decrypt a readable stream into `destPath`.
 * Used where driving the stream manually is not necessary.
 */
function decryptStreamToFile(input, destPath, expectedLength, onProgress) {
  const fs = require('fs');
  const dec = new FileDecryptStream(onProgress);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { input.destroy(); } catch (_e) { /* ignore */ }
      resolve(result);
    };

    input.on('data', (chunk) => {
      try {
        dec.write(chunk);
      } catch (e) {
        finish({ ok: false, reason: 'decrypt: ' + e.message });
      }
    });
    input.on('end', () => dec.finalize(destPath, expectedLength).then(finish));
    input.on('error', (err) => finish({ ok: false, reason: 'stream: ' + err.message }));
    void fs;
  });
}

/** Encrypt a file and stream it into `dest` (16 byte random IV + AES-256-CTR). */
function encryptFileToStream(filePath, dest, onProgress) {
  const fs = require('fs');

  return new Promise((resolve) => {
    let total = 0;
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      resolve({ ok: false, reason: e.message });
      return;
    }

    const iv = crypto.randomBytes(16);
    const encryptor = crypto.createCipheriv('aes-256-ctr', DIRECT_STREAM_KEY, iv);
    const source = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

    const done = (ok, reason) => {
      try { source.destroy(); } catch (_e) { /* ignore */ }
      resolve({ ok, reason });
    };

    source.on('data', (chunk) => {
      const enc = encryptor.update(chunk);
      total += chunk.length;
      if (onProgress) onProgress(total, size);
      if (enc.length > 0) dest.write(enc);
    });
    source.on('end', () => {
      try {
        const tail = encryptor.final();
        if (tail && tail.length > 0) dest.write(tail);
      } catch (e) {
        done(false, e.message);
        return;
      }
      done(true);
    });
    source.on('error', (e) => done(false, e.message));
    dest.on('error', (e) => done(false, e.message));

    dest.write(iv);
  });
}

module.exports = {
  MAGIC_PACKET,
  MAGIC_FILE,
  SERVER_PORT,
  UDP_BROADCAST_PORT,
  UDP_AUDIO_PORT,
  CALL_VIDEO_PORT,
  CALL_AUDIO_PORT,
  MULTICAST_IP,
  SAMPLE_RATE,
  SERVICE_TYPE,
  SignalType,
  DIRECT_STREAM_KEY,
  uuid,
  createPacket,
  packetToJson,
  packetFromJson,
  encodeFrame,
  encodePacketFrame,
  FrameReader,
  FileDecryptStream,
  decryptStreamToFile,
  encryptFileToStream,
};