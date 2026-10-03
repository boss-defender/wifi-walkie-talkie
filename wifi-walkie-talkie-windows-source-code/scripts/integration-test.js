'use strict';
/**
 * Integration smoke test for the P2P stack.
 *
 * Boots a real P2PRepository (TCP :8888, UDP :8887, UDP audio/call sockets,
 * mDNS advertiser) against a temporary store, then drives it with a raw client
 * that speaks the Android wire format. Verifies:
 *
 *   - ports bind cleanly
 *   - TCP packet framing (0x01 + big-endian length + JSON)
 *   - PING -> PONG heartbeats and peer discovery
 *   - CHAT_MSG delivery + MSG_ACK
 *   - encrypted file relay (magic 0x02, AES-256-CTR) with byte-exact recovery
 *   - UDP broadcast signalling
 *   - walkie-talkie audio frames arriving as raw PCM16
 *
 * Run:  node scripts/integration-test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src', 'main', 'store'));
const { P2PRepository } = require(path.join(ROOT, 'src', 'main', 'repository'));
const proto = require(path.join(ROOT, 'src', 'main', 'protocol'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-int-'));
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw control-packet client, mirroring LocalP2PServer.sendPacket. */
function sendPacket(ip, port, packet) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port }, () => {
      socket.end(proto.encodePacketFrame(packet), () => {
        socket.destroy();
        resolve(true);
      });
    });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(4000, () => { socket.destroy(); resolve(false); });
  });
}

function makePacket(type, payload, targetId = 'GLOBAL', extraData = null) {
  return proto.createPacket({
    type,
    senderId: 'TESTER',
    senderName: 'Tester',
    targetId,
    payload,
    extraData,
  });
}

async function main() {
  console.log('\n=== WiFi Walkie-Talkie :: P2P integration test ===\n');
  console.log(`workspace: ${tmpDir}`);

  // Every assertion below drives a real socket on a fixed port. If another copy
  // of the app is already running (a leftover smoke-test instance, or a second
  // device sharing this host's loopback), the test silently attaches to THAT
  // process and reports a dozen confusing failures while the code is fine.
  // Fail loudly and immediately instead.
  const busy = await new Promise((resolve) => {
    const probe = net.createConnection({ host: '127.0.0.1', port: proto.SERVER_PORT }, () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
    probe.setTimeout(1500, () => { probe.destroy(); resolve(false); });
  });
  if (busy) {
    console.error(
      `\nABORT: TCP ${proto.SERVER_PORT} is already in use, so this test would measure` +
      `\n       the wrong process. Close any running WiFi Walkie-Talkie instance and retry.\n`,
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  const store = new Store(tmpDir).load();
  const repo = new P2PRepository(store, { onStateChange: () => {} });

  console.log('--- booting repository ---');
  repo.start();
  await sleep(2500);

  const snap = repo.snapshot();
  console.log(`  local ip   : ${snap.localIp}`);
  console.log(`  interface  : ${snap.interfaceName}`);
  console.log(`  broadcast  : ${snap.broadcastAddress}`);

  check('local IPv4 address detected', /^\d+\.\d+\.\d+\.\d+$/.test(snap.localIp), snap.localIp);
  check('TCP server port reported as 8888', snap.ports.tcp === 8888);

  // ---------------------------------------------------------------- ports
  console.log('\n--- port bindings ---');
  const portOpen = (port, host) => new Promise((resolve) => {
    const s = net.createConnection({ host: host || '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });

  check('TCP 8888 accepting connections', await portOpen(proto.SERVER_PORT));

  // The call media channels are UDP sinks: they never echo, they raise an event.
  // Inject a frame on each and assert the media engine surfaces it.
  const inject = (event, port, payload) => new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    const onFrame = (frame) => {
      repo.media.off(event, onFrame);
      clearTimeout(timer);
      probe.close();
      resolve(frame);
    };
    const timer = setTimeout(() => {
      repo.media.off(event, onFrame);
      probe.close();
      resolve(null);
    }, 1500);
    repo.media.on(event, onFrame);
    probe.send(payload, 0, payload.length, port, '127.0.0.1');
  });

  const callAudioFrame = await inject('call-audio-frame', proto.CALL_AUDIO_PORT, Buffer.alloc(512, 7));
  check('UDP 8890 (call audio) frame delivered to media engine', !!callAudioFrame);
  check('call audio payload preserved',
    !!callAudioFrame && Buffer.from(callAudioFrame.pcm, 'base64').length === 512);

  // JPEG magic bytes, so the video sink accepts it (>= 2 byte guard).
  const jpegProbe = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
  const callVideoFrame = await inject('call-video-frame', proto.CALL_VIDEO_PORT, jpegProbe);
  check('UDP 8889 (call video) frame delivered to media engine', !!callVideoFrame);
  check('call video payload preserved',
    !!callVideoFrame && Buffer.from(callVideoFrame.jpeg, 'base64').equals(jpegProbe));

  // The computed subnet broadcast must be inside the same /24 as our address.
  if (snap.broadcastAddress) {
    const octets = (s) => String(s).split('.').map(Number);
    const [a1, a2, a3] = octets(snap.localIp);
    const [b1, b2, b3] = octets(snap.broadcastAddress);
    check('subnet broadcast shares the /24 prefix',
      a1 === b1 && a2 === b2 && a3 === b3,
      `${snap.localIp} vs ${snap.broadcastAddress}`);
  } else {
    check('subnet broadcast computed', false, 'none');
  }

  // ------------------------------------------------------------- heartbeat
  console.log('\n--- PING / PONG heartbeat ---');
  const pingOk = await sendPacket(snap.localIp, proto.SERVER_PORT,
    makePacket(proto.SignalType.PING, String(Date.now())));
  check('PING frame accepted by TCP server', pingOk);

  await sleep(600);
  const peersAfterPing = repo.snapshot().peers;
  const self = peersAfterPing.find((p) => p.ipAddress === snap.localIp);
  check('local device pinned as first peer entry', !!self, JSON.stringify(peersAfterPing));

  // ----------------------------------------------------------- text message
  console.log('\n--- CHAT_MSG delivery + ACK ---');
  const msgId = crypto.randomUUID();
  const chatPacket = makePacket(proto.SignalType.CHAT_MSG, 'hello from linux test', 'GLOBAL', null);
  chatPacket.msgId = msgId;
  await sendPacket(snap.localIp, proto.SERVER_PORT, chatPacket);

  await sleep(700);
  const globals = repo.store.getGlobalMessages();
  const received = globals.find((m) => m.id === msgId);
  check('broadcast message stored', !!received);
  check('message content preserved', received && received.content === 'hello from linux test');
  check('sender name preserved', received && received.senderName === 'Tester');

  // ------------------------------------------- private chat visibility
  // Regression guard: incoming PRIVATE messages are stored with
  // senderId == receiverId == senderIp (exactly as Android does). A previous
  // version of getMessagesForChat compared those fields against chatId instead
  // of against 'GLOBAL', which classified every incoming message as a
  // self-message and hid the whole received conversation from the user.
  console.log('\n--- private chat visibility (regression) ---');
  // The repository keys a conversation by the SOURCE address it saw on the wire.
  // This test dials the host's own LAN address, so that is the "peer" identity
  // the incoming message will be filed under.
  const PEER_IP = snap.localIp;
  const privMsgId = crypto.randomUUID();
  const privPacket = makePacket(proto.SignalType.CHAT_MSG, 'private hello', PEER_IP, null);
  privPacket.msgId = privMsgId;
  await sendPacket(snap.localIp, proto.SERVER_PORT, privPacket);
  await sleep(700);

  const privChat = repo.store.getMessagesForChat(PEER_IP);
  const privReceived = privChat.find((m) => m.id === privMsgId);
  check('incoming private message is visible in its chat', !!privReceived,
    `chat returned ${privChat.length} message(s)`);
  check('incoming private content preserved',
    privReceived && privReceived.content === 'private hello');
  check('incoming private message is not marked outgoing',
    privReceived && privReceived.isOutgoing === false);

  // And the same conversation must still render our own replies.
  repo.store.upsertMessage({
    id: 'local-reply-1', senderId: repo.deviceId, senderName: 'Me',
    receiverId: PEER_IP, content: 'my reply', type: 'TEXT', mediaPath: null,
    fileSize: 0, timestamp: Date.now() + 1000, isOutgoing: true,
    status: 'DELIVERED', isStarred: false,
  });
  const bothWays = repo.store.getMessagesForChat(PEER_IP);
  check('chat shows both directions', bothWays.length >= 2, `${bothWays.length} message(s)`);

  // Broadcast messages must never leak into a 1-on-1 conversation.
  check('broadcast messages excluded from private chat',
    !bothWays.some((m) => m.receiverId === 'GLOBAL'));

  // ------------------------------------------------------------ ACK reply
  console.log('\n--- MSG_ACK on outbound private message ---');
  const ackServer = net.createServer((socket) => {
    const reader = new proto.FrameReader((_magic, payload) => {
      const pkt = proto.packetFromJson(payload.toString('utf8'));
      if (pkt && pkt.type === proto.SignalType.MSG_ACK) {
        check('ACK carries the original msgId', pkt.payload === msgId, pkt.payload);
        check('ACK targetId is the original senderId', pkt.targetId === 'TESTER', pkt.targetId);
      }
    });
    socket.on('data', (c) => reader.push(c));
  });

  // ------------------------------------------------------------ file relay
  console.log('\n--- encrypted file relay (AES-256-CTR) ---');
  const payloadSize = 300 * 1024;
  const filePayload = crypto.randomBytes(payloadSize);
  const sourceFile = path.join(tmpDir, 'source.bin');
  fs.writeFileSync(sourceFile, filePayload);

  // Tell the repository an inbound file is arriving, then push the real
  // Android-shaped frame: magic 0x02 + header JSON + IV + ciphertext.
  const header = makePacket(
    proto.SignalType.FILE_HEADER,
    'payload.bin',
    'GLOBAL',
    String(payloadSize),
  );

  const fileReceived = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file never arrived')), 25000);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', proto.DIRECT_STREAM_KEY, iv);

    const socket = net.createConnection({ host: snap.localIp, port: proto.SERVER_PORT }, () => {
      socket.write(proto.encodeFrame(proto.MAGIC_FILE, Buffer.from(proto.packetToJson(header), 'utf8')));
      socket.write(iv);
      // Stream in awkward chunks to exercise the incremental frame reader.
      let offset = 0;
      const chunk = 64 * 1024;
      const pump = () => {
        while (offset < filePayload.length) {
          const end = Math.min(offset + chunk, filePayload.length);
          const plain = filePayload.subarray(offset, end);
          // AES-CTR emits no final block, so `enc` is the whole last chunk and
          // must be written unconditionally.
          const enc = cipher.update(plain);
          const tail = offset + chunk >= filePayload.length ? cipher.final() : Buffer.alloc(0);
          socket.write(Buffer.concat([enc, tail]));
          offset = end;
        }
        socket.end();
      };
      pump();
    });

    socket.on('error', reject);
    socket.on('close', () => {
      setTimeout(() => {
        const dir = store.receivedDir;
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        if (files.length > 0) {
          const got = fs.readFileSync(path.join(dir, files[0]));
          clearTimeout(timer);
          resolve({ name: files[0], bytes: got.length, matches: got.equals(filePayload) });
        } else {
          clearTimeout(timer);
          reject(new Error('no file written'));
        }
      }, 1500);
    });
  });

  try {
    const result = await fileReceived;
    check('received file written to storage', result.bytes > 0);
    check('decrypted size matches original', result.bytes === payloadSize, `${result.bytes} vs ${payloadSize}`);
    check('decrypted bytes are IDENTICAL to original', result.matches);
  } catch (e) {
    check('encrypted file relay', false, e.message);
  }

  // ------------------------------------------------------------ UDP signal
  console.log('\n--- UDP broadcast signalling ---');
  const udpMsgId = crypto.randomUUID();
  const udpBefore = repo.store.getGlobalMessages().length;
  const udpPacket = makePacket(proto.SignalType.CHAT_MSG, 'udp hello', 'GLOBAL');
  udpPacket.msgId = udpMsgId;

  const udpProbe = dgram.createSocket('udp4');
  udpProbe.send(
    Buffer.from(proto.packetToJson(udpPacket), 'utf8'),
    proto.UDP_BROADCAST_PORT,
    '127.0.0.1',
  );
  await sleep(800);
  udpProbe.close();

  const udpGlobals = repo.store.getGlobalMessages();
  const udpMsg = udpGlobals.find((m) => m.id === udpMsgId);
  check('UDP broadcast signal parsed and stored', !!udpMsg);
  check('UDP message content preserved', udpMsg && udpMsg.content === 'udp hello');
  check('UDP delivery did not duplicate', udpGlobals.length === udpBefore + 1,
    `${udpBefore} -> ${udpGlobals.length}`);

  // --------------------------------------------------------- audio channels
  console.log('\n--- UDP audio channels ---');
  const audioSeen = [];
  const onWalkie = (frame) => audioSeen.push(frame);
  repo.media.on('walkie-frame', onWalkie);

  const pcm = crypto.randomBytes(1024);
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve) => {
    probe.send(pcm, 0, pcm.length, proto.UDP_AUDIO_PORT, '127.0.0.1', () => setTimeout(resolve, 500));
  });
  probe.close();
  await sleep(600);

  const walkieFrames = audioSeen.filter((f) => f.bytes === pcm.length);
  check('walkie-talkie PCM frame received on :9999', walkieFrames.length > 0, JSON.stringify(audioSeen.map((f) => f.bytes)));
  if (walkieFrames.length > 0) {
    check('walkie frame payload preserved',
      Buffer.from(walkieFrames[0].pcm, 'base64').equals(pcm));
  }
  repo.media.off('walkie-frame', onWalkie);

  // ----------------------------------------------------------- duplicates
  console.log('\n--- duplicate suppression ---');
  const dupId = crypto.randomUUID();
  const before = repo.store.getGlobalMessages().length;
  const dupPacket = makePacket(proto.SignalType.CHAT_MSG, 'duplicate test', 'GLOBAL');
  dupPacket.msgId = dupId;
  await sendPacket(snap.localIp, proto.SERVER_PORT, dupPacket);
  await sleep(300);
  const afterFirst = repo.store.getGlobalMessages().length;
  // Same packet over a different transport must not be stored twice.
  const udpDup = dgram.createSocket('udp4');
  udpDup.send(
    Buffer.from(proto.packetToJson(dupPacket), 'utf8'),
    proto.UDP_BROADCAST_PORT,
    '127.0.0.1',
  );
  await sleep(600);
  const afterSecond = repo.store.getGlobalMessages().length;
  udpDup.close();

  check('first delivery stored exactly once', afterFirst === before + 1, `${before} -> ${afterFirst}`);
  check('re-delivery over UDP suppressed', afterSecond === afterFirst, `${afterFirst} -> ${afterSecond}`);

  // ------------------------------------------------------------- framing
  console.log('\n--- FrameReader robustness ---');
  const reader = new proto.FrameReader(() => {});
  const a = proto.encodePacketFrame(makePacket(proto.SignalType.PING, 'a'));
  const b = proto.encodePacketFrame(makePacket(proto.SignalType.PING, 'bb'));
  const stream = Buffer.concat([a, b]);
  const decoded = [];
  const r2 = new proto.FrameReader((_m, payload) => decoded.push(JSON.parse(payload.toString('utf8')).payload));
  for (let i = 0; i < stream.length; i += 7) r2.push(stream.subarray(i, Math.min(i + 7, stream.length)));
  check('byte-by-byte reassembly yields both packets',
    decoded.length === 2 && decoded[0] === 'a' && decoded[1] === 'bb', JSON.stringify(decoded));

  // -------------------------------------------------------------- cleanup
  console.log('\n--- shutdown ---');
  repo.stop();
  await sleep(700);
  check('TCP port released after stop', !(await portOpen(proto.SERVER_PORT)));
  store.close();

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nINTEGRATION TEST CRASHED:', e);
  process.exit(1);
});