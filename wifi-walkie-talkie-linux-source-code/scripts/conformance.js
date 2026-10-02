'use strict';
/**
 * Cross-platform crypto conformance check.
 *
 * Encrypts / decrypts with the Linux implementation using the exact code paths
 * used in production (src/main/protocol.js) so the output can be compared with
 * the Android implementation compiled from BinaryStreamRelay.kt semantics.
 *
 *   node conformance.js encrypt <in> <ivHex> <out>
 *   node conformance.js decrypt <in> <out>
 */

const fs = require('fs');
const crypto = require('crypto');
const proto = require('../src/main/protocol');

const [mode, inPath, a, b] = process.argv.slice(2);

if (mode === 'encrypt') {
  const data = fs.readFileSync(inPath);
  const iv = Buffer.from(a, 'hex');
  const cipher = crypto.createCipheriv('aes-256-ctr', proto.DIRECT_STREAM_KEY, iv);
  const body = cipher.update(data);
  const tail = cipher.final();
  fs.writeFileSync(b, Buffer.concat([iv, body, tail]));
  console.log(`WROTE ${16 + body.length + tail.length} bytes`);
  process.exit(0);
}

if (mode === 'decrypt') {
  const payload = fs.readFileSync(inPath);
  const iv = payload.subarray(0, 16);
  const body = payload.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', proto.DIRECT_STREAM_KEY, iv);
  const out = Buffer.concat([decipher.update(body), decipher.final()]);
  fs.writeFileSync(b || a, out);
  console.log(`WROTE ${out.length} bytes`);
  process.exit(0);
}

console.error('usage: conformance.js encrypt|decrypt <in> <ivHex|out> [out]');
process.exit(2);