'use strict';
/**
 * app.js — Renderer UI controller.
 *
 * Talks to the main process exclusively through `window.walkie` (preload.js).
 */

const api = window.walkie;

const state = {
  snapshot: null,
  activeTab: 'radio',
  selectedChatId: null,
  hubMessages: [],
  chatMessages: [],
  listeningEnabled: true,
  isTransmitting: false,
  isReceiving: false,
  activeChatId: null,
  lastIncomingId: null,
  talkingPeer: null,
  callStartedAt: 0,
  callTimerHandle: null,
  lastRemoteFrameAt: 0,
};

const audio = new AudioEngine(api);

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

// HTML-escape helper. Entities are assembled from char codes so that this
// source file stays free of literal entity sequences.
const HTML_ESCAPES = {
  [String.fromCharCode(38)]: String.fromCharCode(38) + "amp;",
  [String.fromCharCode(60)]: String.fromCharCode(38) + "lt;",
  [String.fromCharCode(62)]: String.fromCharCode(38) + "gt;",
  [String.fromCharCode(34)]: String.fromCharCode(38) + "quot;",
  [String.fromCharCode(39)]: String.fromCharCode(38) + "#39;",
};

const HTML_UNSAFE_RE = /[&<>"']/g;

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(
    HTML_UNSAFE_RE,
    (ch) => HTML_ESCAPES[ch],
  );
}


function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? formatTime(ts) : d.toLocaleDateString();
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toast(message, kind = 'info') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, 3600);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const p of document.querySelectorAll('.panel')) {
        p.classList.toggle('active', p.id === `panel-${state.activeTab}`);
      }
      if (state.activeTab === 'hub') refreshHub();
      if (state.activeTab === 'chats') refreshChats();
      if (state.activeTab === 'settings') refreshSettings();
      if (state.activeTab !== 'chats') closeCallOverlay();
    });
  }
}

// ---------------------------------------------------------------------------
// header / status
// ---------------------------------------------------------------------------

function renderHeader() {
  const s = state.snapshot;
  if (!s) return;

  $('displayNameBtn').textContent = s.displayName;
  $('networkLine').textContent = `${s.ssid || 'Wi-Fi'} · ${s.localIp || 'no address'}`;

  const pill = $('statusPill');
  const status = s.status;
  pill.className = 'status-pill';
  if (status === 'CONNECTED') pill.classList.add('status-connected');
  else if (status === 'DISCONNECTED') pill.classList.add('status-disconnected');
  else pill.classList.add('status-searching');
  $('statusText').textContent = status;

  const remotePeers = s.peers.filter((p) => p.ipAddress !== s.localIp && p.isOnline);
  $('peerCount').textContent = `${remotePeers.length} peer${remotePeers.length === 1 ? '' : 's'}`;

  const unread = s.peers.reduce((sum, p) => sum + (p.unreadCount || 0), 0);
  const badge = $('chatsBadge');
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  $('channelNumber').textContent = String(s.currentChannel);
  $('settingsChannel').value = s.currentChannel;
  $('settingsName').value = s.displayName;
  $('settingsAutoDelete').checked = !!s.autoDeleteOldMessages;
  renderIncoming(s);
}

function renderIncoming(s) {
  const banner = $('incomingBanner');
  if (s.incomingCall) {
    banner.classList.remove('hidden');
    $('incomingName').textContent = s.incomingCall.callerName;
    $('incomingSub').textContent = s.incomingCall.isVideoCall
      ? 'Incoming video call'
      : 'Incoming voice call';
    $('incomingAvatar').textContent = initials(s.incomingCall.callerName);
  } else {
    banner.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// walkie-talkie
// ---------------------------------------------------------------------------

function updateChannelStatus() {
  const s = state.snapshot;
  const channel = s ? s.currentChannel : 1;
  const el = $('channelStatus');
  if (state.isTransmitting) {
    el.textContent = `You are speaking to Channel ${channel}`;
  } else if (state.isReceiving && state.talkingPeer) {
    el.textContent = `Incoming audio from ${state.talkingPeer}`;
  } else if (!state.listeningEnabled) {
    el.textContent = 'Incoming walkie-talkie audio is muted';
  } else {
    el.textContent = `Channel ${channel} is clear and listening`;
  }
}

async function beginTransmit() {
  if (state.isTransmitting) return;

  // Acquire the microphone first, and report that failure separately — otherwise
  // unrelated errors surface as a misleading "Microphone unavailable" message.
  try {
    await audio.ensureMicrophone();
  } catch (e) {
    toast(`Microphone unavailable: ${e.message}`, 'error');
    return;
  }

  try {
    await audio.ensureContext();
    await audio.startWalkieTransmit();
    state.isTransmitting = true;
    $('pttButton').classList.add('active');
    $('pttLabel').textContent = 'SPEAKING';
    await api.setTransmitting(true);
    updateChannelStatus();
  } catch (e) {
    state.isTransmitting = false;
    toast(`Could not start transmission: ${e.message}`, 'error');
  }
}

async function endTransmit() {
  if (!state.isTransmitting) return;
  state.isTransmitting = false;
  audio.stopWalkieTransmit();
  $('pttButton').classList.remove('active');
  $('pttLabel').textContent = 'HOLD TO SPEAK';
  await api.setTransmitting(false);
  updateChannelStatus();
}

function setupWalkie() {
  const ptt = $('pttButton');

  const press = (e) => {
    e.preventDefault();
    beginTransmit();
  };
  const release = () => { endTransmit(); };

  ptt.addEventListener('mousedown', press);
  ptt.addEventListener('touchstart', press, { passive: false });
  window.addEventListener('mouseup', release);
  window.addEventListener('touchend', release);
  ptt.addEventListener('mouseleave', release);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard: hold SPACE to talk.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    beginTransmit();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    endTransmit();
  });

  $('listenToggle').addEventListener('change', (e) => {
    state.listeningEnabled = e.target.checked;
    if (!state.listeningEnabled) audio.flushPlayback();
    updateChannelStatus();
  });

  $('channelUp').addEventListener('click', () => changeChannel(1));
  $('channelDown').addEventListener('click', () => changeChannel(-1));

  api.onWalkieAudio((base64, from) => {
    // Never play our own voice back, and honour the listen toggle.
    if (state.isTransmitting || !state.listeningEnabled) return;
    state.isReceiving = true;
    state.talkingPeer = from;
    audio.pushWalkiePlayback(base64);
    audio.walkieFramesIn += 1;
    updateChannelStatus();
  });

  // Clear the "receiving" indicator when the channel goes quiet.
  setInterval(() => {
    if (state.isReceiving && !state.isTransmitting) {
      state.isReceiving = false;
      state.talkingPeer = null;
      updateChannelStatus();
    }
    $('walkieStats').textContent = `${audio.walkieFramesIn} frames received · ${audio.walkieFramesOut} sent`;
    $('talkPeerLabel').textContent = state.isReceiving && state.talkingPeer
      ? `Receiving from ${state.talkingPeer}`
      : (state.isTransmitting ? 'Transmitting' : 'Idle');
  }, 250);
}

async function changeChannel(delta) {
  const current = state.snapshot ? state.snapshot.currentChannel : 1;
  const next = Math.min(99, Math.max(1, current + delta));
  const r = await api.setChannel(next);
  if (r && r.channel) {
    $('channelNumber').textContent = String(r.channel);
    updateChannelStatus();
  }
}

// ---------------------------------------------------------------------------
// waveform canvas
// ---------------------------------------------------------------------------

let waveCanvas = null;
let waveCtx = null;
const VIS_BAR_COUNT = 56;      // drawn bars (interpolated from the 16 analysed buckets)
const VIS_MIN_BAR = 3;
// Smoothed display values so the visualiser glides between 64 ms capture frames.
let visBars = new Array(VIS_BAR_COUNT).fill(VIS_MIN_BAR);
let visLevel = 0;
let visPeak = 0.05;            // rolling peak, used for automatic gain
let speechActive = false;
let visRaf = 0;
let visLast = 0;
let visTravel = 0;
const visSparks = [];         // spark particles thrown from the loudest bars

function initWaveform() {
  waveCanvas = $('waveform');
  waveCtx = waveCanvas.getContext('2d');
  resizeWaveform();
  window.addEventListener('resize', resizeWaveform);
  if (!visRaf) {
    visLast = performance.now();
    visRaf = requestAnimationFrame(visLoop);
  }
}

/** 60 fps render loop — the old 250 ms tick was the source of the laggy feel. */
function visLoop(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - visLast) / 1000));
  visLast = now;
  drawWaveform(dt, now / 1000);
  visRaf = requestAnimationFrame(visLoop);
}

function resizeWaveform() {
  if (!waveCanvas) return;
  const rect = waveCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  waveCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Frame-rate independent exponential smoothing (fast attack, slower release). */
function smooth(current, target, dt, attack, release) {
  const k = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / k));
}

/** Linear interpolation of the 16 analysed buckets up to the drawn bar count. */
function sampleWave(src, i, n) {
  const pos = (i / (n - 1)) * (src.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, src.length - 1);
  const f = pos - i0;
  return src[i0] * (1 - f) + src[i1] * f;
}

function drawWaveform(dt, t) {
  if (!waveCtx) return;
  const rect = waveCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w < 2 || h < 2) return;
  const centerY = h / 2;

  // Which signal are we showing: our own voice, or the peer we hear?
  let source = null;
  let level = 0;
  let mode = 'idle';
  if (state.isTransmitting) {
    source = audio.liveWaveform; level = audio.liveLevel; mode = 'tx';
  } else if (state.isReceiving) {
    source = audio.rxWaveform; level = audio.rxLevel; mode = 'rx';
  }

  // --- auto-gain -----------------------------------------------------------
  // Microphone sensitivity varies wildly between laptops and USB headsets. Track
  // a slowly decaying peak and normalise against it, so quiet mics still fill the
  // display and loud mics do not sit permanently pinned at full scale.
  let maxTarget = 0;
  if (source) {
    for (let i = 0; i < source.length; i++) if (source[i] > maxTarget) maxTarget = source[i];
  }
  visPeak = Math.max(maxTarget, visPeak * 0.995, 0.04);
  const gain = 0.92 / visPeak;

  for (let i = 0; i < VIS_BAR_COUNT; i++) {
    const raw = source ? sampleWave(source, i, VIS_BAR_COUNT) : 0;
    const target = source ? Math.max(VIS_MIN_BAR / h, raw * gain) : VIS_MIN_BAR / h;
    visBars[i] = smooth(visBars[i], target, dt, 0.035, 0.14);
  }
  visLevel = smooth(visLevel, source ? level : 0, dt, 0.05, 0.22);
  visTravel = (visTravel + dt * (0.35 + visLevel * 1.5)) % 1;

  // --- palette -------------------------------------------------------------
  const rgb = mode === 'tx' ? '239, 68, 68' : mode === 'rx' ? '52, 211, 153' : '148, 176, 214';
  const energy = Math.min(1, visLevel);

  waveCtx.clearRect(0, 0, w, h);

  // Soft ambient glow, brightest when the voice is loud.
  if (source && visLevel > 0.015) {
    const g = waveCtx.createRadialGradient(w / 2, centerY, 0, w / 2, centerY, w * 0.55);
    g.addColorStop(0, `rgba(${rgb},${0.05 + energy * 0.22})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    waveCtx.fillStyle = g;
    waveCtx.fillRect(0, 0, w, h);
  }

  const gap = 3;
  const barWidth = Math.max(2, (w - gap * (VIS_BAR_COUNT - 1)) / VIS_BAR_COUNT);
  const maxBar = h * 0.92;

  // Vibrating offset: a fast tremor plus a travelling ripple, both scaled by how
  // loud the voice actually is. Silence while transmitting => no tremor, so the
  // motion genuinely tracks speech instead of looping blindly.
  const tremor = Math.sin(t * 46) * energy * 1.9;
  const ripplePhase = t * 7.5;
  const sweepX = visTravel * (w + 120) - 60;

  // Compute geometry once, then paint ghosts + the live bar per column.
  const heights = new Array(VIS_BAR_COUNT);
  for (let i = 0; i < VIS_BAR_COUNT; i++) {
    // Bars near the centre are amplified, giving a classic spectrum silhouette.
    const centreBias = 1 - Math.abs(i - (VIS_BAR_COUNT - 1) / 2) / VIS_BAR_COUNT * 0.55;
    let amp = visBars[i] * centreBias;
    const ripple = Math.sin(ripplePhase - i * 0.42) * energy * 0.10;
    heights[i] = Math.max(VIS_MIN_BAR, (amp + ripple) * maxBar);
  }

  // --- motion-trail ghosts --------------------------------------------------
  // Fading copies of the previous frames read as motion blur and make the bars
  // feel fast even though the source only updates every 64 ms.
  if (source && energy > 0.03) {
    waveCtx.save();
    for (let g = 3; g >= 1; g--) {
      const shrink = 1 - g * 0.045;
      waveCtx.fillStyle = `rgba(${rgb},${0.05 * g * (0.5 + energy)})`;
      for (let i = 0; i < VIS_BAR_COUNT; i++) {
        const x = i * (barWidth + gap) + barWidth / 2;
        const bh = Math.max(VIS_MIN_BAR, heights[i] * shrink);
        roundRect(waveCtx, x - barWidth / 2, centerY - bh / 2, barWidth, bh, barWidth / 2);
        waveCtx.fill();
      }
    }
    waveCtx.restore();
  }

  // --- live bars ------------------------------------------------------------
  waveCtx.save();
  if (source && energy > 0.02) {
    waveCtx.shadowColor = `rgba(${rgb},${0.45 + energy * 0.5})`;
    waveCtx.shadowBlur = 12 + energy * 26;
  }
  for (let i = 0; i < VIS_BAR_COUNT; i++) {
    const x = i * (barWidth + gap) + barWidth / 2;
    const barH = heights[i];
    const jitter = Math.sin(t * 52 + i * 1.9) * energy * 2.1;
    const bx = x + tremor + jitter;
    const by = centerY + Math.sin(t * 9.5 + i * 0.3) * energy * 1.6;

    // Hotter bars glow toward white as they get louder.
    const heat = Math.min(1, barH / maxBar);
    const grad = waveCtx.createLinearGradient(0, by - barH / 2, 0, by + barH / 2);
    const core = mode === 'tx'
      ? `rgba(255,${Math.round(150 + heat * 90)},${Math.round(120 + heat * 100)},`
      : mode === 'rx'
        ? `rgba(${Math.round(160 + heat * 95)},255,${Math.round(210 + heat * 45)},`
        : `rgba(${rgb},`;
    grad.addColorStop(0, core + `${0.35 + heat * 0.35})`);
    grad.addColorStop(0.5, core + `${0.75 + heat * 0.25})`);
    grad.addColorStop(1, core + `${0.35 + heat * 0.35})`);
    waveCtx.fillStyle = source ? grad : `rgba(${rgb},0.28)`;

    roundRect(waveCtx, bx - barWidth / 2, by - barH / 2, barWidth, barH, barWidth / 2);
    waveCtx.fill();

    // Bright cap so the bar tips read as "live".
    if (source && barH > 6) {
      waveCtx.shadowBlur = 0;
      waveCtx.fillStyle = `rgba(255,255,255,${0.18 + heat * 0.5})`;
      waveCtx.fillRect(bx - barWidth / 2, by - barH / 2, barWidth, 1.6);
      waveCtx.fillRect(bx - barWidth / 2, by + barH / 2 - 1.6, barWidth, 1.6);
      waveCtx.shadowBlur = 12 + energy * 26;
    }
  }
  waveCtx.restore();

  // --- spark particles ------------------------------------------------------
  // Emitted from the tips of the loudest bars while transmitting.
  if (source && mode === 'tx' && energy > 0.12) {
    const budget = Math.min(3, Math.floor(energy * 4));
    for (let k = 0; k < budget; k++) {
      const i = Math.floor(Math.random() * VIS_BAR_COUNT);
      const x = i * (barWidth + gap) + barWidth / 2;
      const dir = Math.random() < 0.5 ? -1 : 1;
      visSparks.push({
        x, y: centerY + dir * heights[i] / 2,
        vx: (Math.random() - 0.5) * 26,
        vy: dir * (24 + Math.random() * 46),
        life: 1,
      });
    }
  }
  for (let i = visSparks.length - 1; i >= 0; i--) {
    const p = visSparks[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy *= 0.965;
    p.vx *= 0.965;
    p.life -= dt * 1.9;
    if (p.life <= 0) { visSparks.splice(i, 1); continue; }
    if (visSparks.length > 160) { visSparks.splice(i, 1); continue; }
    waveCtx.fillStyle = `rgba(255,${180 - Math.round((1 - p.life) * 60)},140,${p.life * 0.75})`;
    waveCtx.beginPath();
    waveCtx.arc(p.x, p.y, 1.6 * p.life + 0.4, 0, Math.PI * 2);
    waveCtx.fill();
  }

  // Travelling sheen while transmitting — reads clearly as "signal going out".
  if (source && mode === 'tx' && energy > 0.02) {
    const sx = sweepX;
    const sg = waveCtx.createLinearGradient(sx - 50, 0, sx + 50, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, `rgba(255,255,255,${0.10 + energy * 0.16})`);
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    waveCtx.fillStyle = sg;
    waveCtx.fillRect(sx - 50, centerY - maxBar / 2, 100, maxBar);
  }

  // Centre line.
  waveCtx.fillStyle = `rgba(${rgb},0.22)`;
  waveCtx.fillRect(0, centerY - 0.5, w, 1);

  // Reflect the speech indicator on the PTT button itself.
  const talking = mode === 'tx' && visLevel > 0.05;
  if (talking !== speechActive) {
    speechActive = talking;
    const ptt = $('pttButton');
    if (ptt) ptt.classList.toggle('speaking', talking);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// peers + messages
// ---------------------------------------------------------------------------

function peerRowHtml(peer, selfIp, options = {}) {
  const isSelf = peer.ipAddress === selfIp;
  const rtt = peer.rttMs >= 0 ? `${peer.rttMs} ms` : '—';
  const stateText = isSelf ? 'This device' : (peer.isOnline ? (peer.isUnreachable ? 'Unreachable' : 'Online') : 'Offline');
  const unread = peer.unreadCount || 0;
  const selected = options.selected ? ' selected' : '';
  const snippet = peer.lastMessageSnippet
    ? `<div class="peer-snippet">${escapeHtml(peer.lastMessageSnippet)}</div>`
    : '<div class="peer-snippet muted">No messages yet</div>';

  return `
    <div class="peer-row${selected}" data-ip="${escapeHtml(peer.ipAddress)}">
      <div class="avatar" style="background:#${(peer.avatarColor || 0x3b82f6).toString(16).padStart(6, '0')}">
        ${escapeHtml(initials(isSelf ? state.snapshot.displayName : peer.displayName))}
      </div>
      <div class="peer-info">
        <div class="peer-name">
          ${escapeHtml(peer.displayName)}
          ${isSelf ? '<span class="tag">YOU</span>' : ''}
        </div>
        ${snippet}
        <div class="peer-meta">
          <span class="dot-state ${peer.isOnline ? 'on' : 'off'}"></span>
          <span>${escapeHtml(stateText)}</span>
          <span class="sep">·</span>
          <span>${escapeHtml(peer.ipAddress)}</span>
          <span class="sep">·</span>
          <span>${rtt}</span>
        </div>
      </div>
      ${unread > 0 ? `<div class="unread">${unread > 99 ? '99+' : unread}</div>` : ''}
      ${options.showActions && !isSelf ? `
        <div class="peer-actions">
          <button class="mini-btn" data-action="call-audio" data-ip="${escapeHtml(peer.ipAddress)}" title="Voice call">&#9742;</button>
          <button class="mini-btn" data-action="call-video" data-ip="${escapeHtml(peer.ipAddress)}" title="Video call">&#128249;</button>
          <button class="mini-btn" data-action="chat" data-ip="${escapeHtml(peer.ipAddress)}" title="Open chat">&#128172;</button>
        </div>` : ''}
    </div>`;
}

function renderPeerLists() {
  const s = state.snapshot;
  if (!s) return;

  const hub = $('hubPeers');
  hub.innerHTML = s.peers.map((p) => peerRowHtml(p, s.localIp, { showActions: true })).join('');

  const chats = $('chatPeers');
  chats.innerHTML = s.peers.map((p) => peerRowHtml(p, s.localIp, {
    selected: p.ipAddress === state.selectedChatId,
  })).join('');

  for (const btn of hub.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ip = btn.dataset.ip;
      if (btn.dataset.action === 'chat') selectChat(ip);
      else if (btn.dataset.action === 'call-audio') startCall(ip, false);
      else if (btn.dataset.action === 'call-video') startCall(ip, true);
    });
  }

  for (const row of chats.querySelectorAll('.peer-row')) {
    row.addEventListener('click', () => {
      const ip = row.dataset.ip;
      if (ip !== s.localIp) selectChat(ip);
    });
  }
}

/** Shared "attachment" row rendered under images and for other file types. */
function fileButtonHtml(msg, icon) {
  const glyph = icon || '&#128206;';
  return `
    <button class="msg-file" data-open="${escapeHtml(msg.mediaPath || '')}">
      <span class="file-icon">${glyph}</span>
      <span class="file-meta">
        <span class="file-name">${escapeHtml(msg.content)}</span>
        <span class="file-size">${formatFileSize(msg.fileSize)}</span>
      </span>
      <span class="file-action">Open</span>
    </button>`;
}

function messageHtml(msg, selfId) {
  const mine = msg.isOutgoing || msg.senderId === selfId;
  const cls = mine ? 'msg-out' : 'msg-in';
  const statusMark = mine ? statusGlyph(msg.status) : '';

  let bodyHtml;
  if (msg.type === 'TEXT') {
    bodyHtml = `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
  } else if (msg.type === 'IMAGE') {
    // Thumbnails are streamed over IPC and injected as data URLs so that the
    // renderer never needs filesystem access.
    bodyHtml = `
      <div class="msg-image" data-thumb="${escapeHtml(msg.mediaPath || "")}">
        <img alt="${escapeHtml(msg.content)}" />
      </div>
      ${fileButtonHtml(msg)}`;
  } else {
    const icon = msg.type === 'VIDEO' ? '&#127916;'
      : msg.type === 'VOICE_NOTE' ? '&#128266;' : '&#128206;';
    bodyHtml = fileButtonHtml(msg, icon);
  }

  return `
    <div class="msg ${cls}" data-id="${escapeHtml(msg.id)}">
      <div class="msg-author">${escapeHtml(msg.senderName || 'Unknown')}</div>
      ${bodyHtml}
      <div class="msg-foot">
        <span>${formatDay(msg.timestamp)}</span>
        <span>${statusMark}</span>
        <button class="star-btn${msg.isStarred ? ' starred' : ''}" data-star="${escapeHtml(msg.id)}" title="Star message">${msg.isStarred ? '★' : '☆'}</button>
      </div>
    </div>`;
}

function statusGlyph(status) {
  switch (status) {
    case 'SENDING': return '&#8987;';
    case 'SENT': return '&#10003;';
    case 'DELIVERED': return '&#10003;&#10003;';
    case 'READ': return '&#128337;';
    case 'FAILED': return '&#10007;';
    default: return '';
  }
}

function renderHubMessages() {
  const list = $('hubMessages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;

  list.innerHTML = state.hubMessages.length === 0
    ? '<div class="empty">No broadcast messages yet. Say hello to the network.</div>'
    : state.hubMessages.map((m) => messageHtml(m, state.snapshot.deviceId)).join('');

  wireMessageActions(list);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function renderChatMessages() {
  const list = $('chatMessages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;

  list.innerHTML = state.chatMessages.length === 0
    ? '<div class="empty">No messages in this conversation.</div>'
    : state.chatMessages.map((m) => messageHtml(m, state.snapshot.deviceId)).join('');

  wireMessageActions(list);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

/** Fetch image payloads for any freshly rendered thumbnail placeholders. */
async function hydrateThumbnails(container) {
  for (const holder of container.querySelectorAll('[data-thumb]')) {
    const path = holder.dataset.thumb;
    if (!path || holder.dataset.loaded === '1') continue;
    holder.dataset.loaded = '1';
    const media = await api.readMedia(path);
    const img = holder.querySelector('img');
    if (!media || !img) {
      holder.remove();
      continue;
    }
    img.src = `data:${media.mime};base64,${media.data}`;
  }
}

function wireMessageActions(container) {
  hydrateThumbnails(container);
  for (const btn of container.querySelectorAll('[data-star]')) {
    btn.addEventListener('click', async () => {
      const el = btn.closest('.msg');
      const next = !btn.classList.contains('starred');
      btn.classList.toggle('starred', next);
      btn.textContent = next ? '★' : '☆';
      await api.toggleStar(btn.dataset.star, next);
      void el;
    });
  }
  for (const btn of container.querySelectorAll('[data-open]')) {
    btn.addEventListener('click', async () => {
      const r = await api.openFile(btn.dataset.open);
      if (!r.ok) toast('Could not open that file', 'error');
    });
  }
}

// ---------------------------------------------------------------------------
// hub actions
// ---------------------------------------------------------------------------

async function refreshHub() {
  state.hubMessages = await api.getGlobalMessages();
  renderHubMessages();
}

function setupHub() {
  const input = $('hubInput');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await api.sendText('GLOBAL', text);
    refreshHub();
  };
  $('hubSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  $('hubAttach').addEventListener('click', async () => {
    const r = await api.sendFile('GLOBAL');
    if (r.ok && r.sent && r.sent.length) {
      toast(`Sent ${r.sent.length} file(s) to the network`, 'success');
    }
    refreshHub();
  });
  $('rescanBtn').addEventListener('click', () => runRescan($('rescanBtn')));
}

// ---------------------------------------------------------------------------
// chats
// ---------------------------------------------------------------------------

async function refreshChats() {
  if (state.selectedChatId) {
    state.chatMessages = await api.getChatMessages(state.selectedChatId);
  }
  renderChatMessages();
  renderPeerLists();
}

/**
 * Rescan the local network for peers.
 *
 * Previously both Rescan controls only fired a toast and did no work at all, so
 * a device that had gone missing could never be recovered without restarting.
 * This drives a real mDNS query + broadcast PING + /24 sweep and reports what it
 * found, then refreshes whichever list is on screen.
 */
async function runRescan(button) {
  if (button && button.disabled) return;
  if (button) button.disabled = true;
  const label = button ? button.textContent : '';
  if (button) button.textContent = 'Scanning…';
  toast('Scanning the local network…', 'info');

  try {
    const r = await api.rescan();
    if (!r || !r.ok) {
      toast('Rescan failed: ' + ((r && r.error) || 'unknown error'), 'error');
    } else if (r.added > 0) {
      toast(`Found ${r.added} new device${r.added === 1 ? '' : 's'} — ${r.peers} on this network`, 'success');
    } else {
      toast(`Scan complete — ${r.peers} device${r.peers === 1 ? '' : 's'} on this network`, 'info');
    }
    renderHeader();
    renderPeerLists();
    await refreshChats();
  } catch (e) {
    toast('Rescan failed: ' + (e && e.message ? e.message : e), 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label || 'Rescan';
    }
  }
}

async function selectChat(ip) {
  state.selectedChatId = ip;
  state.activeChatId = ip;
  const peer = state.snapshot.peers.find((p) => p.ipAddress === ip);
  $('chatTitle').textContent = peer ? peer.displayName : ip;
  $('chatSubtitle').textContent = peer ? `${peer.ipAddress} · private peer-to-peer` : 'Private peer-to-peer conversation';
  $('chatInput').disabled = false;
  $('chatInput').placeholder = `Message ${peer ? peer.displayName : ip}…`;
  document.querySelector('.tab[data-tab="chats"]').click();
  await api.markRead(ip);
  await refreshChats();
}

function setupChats() {
  $('rescanChatsBtn').addEventListener('click', () => runRescan($('rescanChatsBtn')));

  const input = $('chatInput');
  const send = async () => {
    const text = input.value.trim();
    if (!text || !state.selectedChatId) return;
    input.value = '';
    await api.sendText(state.selectedChatId, text);
    await refreshChats();
  };
  $('chatSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  $('chatAttach').addEventListener('click', async () => {
    if (!state.selectedChatId) {
      toast('Pick a device first', 'error');
      return;
    }
    await api.sendFile(state.selectedChatId);
    await refreshChats();
  });
  $('chatClearBtn').addEventListener('click', async () => {
    if (!state.selectedChatId) return;
    await api.clearMessages(state.selectedChatId);
    await refreshChats();
    toast('Conversation cleared');
  });
  $('callAudioBtn').addEventListener('click', () => startCall(state.selectedChatId, false));
  $('callVideoBtn').addEventListener('click', () => startCall(state.selectedChatId, true));
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function refreshSettings() {
  const s = state.snapshot;
  if (!s) return;

  $('settingsNetwork').innerHTML = `
    <dt>Device address</dt><dd>${escapeHtml(s.localIp)}</dd>
    <dt>Network</dt><dd>${escapeHtml(s.ssid)}</dd>
    <dt>Interface</dt><dd>${escapeHtml(s.interfaceName || 'unknown')}</dd>
    <dt>Broadcast</dt><dd>${escapeHtml(s.broadcastAddress || 'n/a')}</dd>
    <dt>Signal port</dt><dd>TCP ${s.ports.tcp} · UDP ${s.ports.udpSignal}</dd>
    <dt>Walkie audio</dt><dd>UDP ${s.ports.udpAudio}</dd>
    <dt>Call media</dt><dd>UDP ${s.ports.callAudio} (audio) · ${s.ports.callVideo} (video)</dd>
    <dt>Received files</dt><dd class="path">${escapeHtml(s.receivedDir)}</dd>`;

  const info = await api.appInfo();
  $('settingsAbout').innerHTML = `
    <dt>Version</dt><dd>${escapeHtml(info.version)}</dd>
    <dt>Runtime</dt><dd>Electron ${escapeHtml(info.electron)} · Chromium ${escapeHtml(info.chrome)}</dd>
    <dt>Node</dt><dd>${escapeHtml(info.node)}</dd>
    <dt>Audio</dt><dd>PCM 16-bit · ${info.sampleRate} Hz · mono</dd>
    <dt>Discovery</dt><dd>mDNS _walkietalkie._tcp</dd>`;
}

function setupSettings() {
  $('settingsSaveName').addEventListener('click', async () => {
    const r = await api.setDisplayName($('settingsName').value);
    if (r.ok) toast(`You are now "${r.displayName}"`, 'success');
    else toast('Name could not be changed', 'error');
  });

  $('settingsSaveChannel').addEventListener('click', async () => {
    const r = await api.setChannel($('settingsChannel').value);
    if (r) toast(`Switched to channel ${r.channel}`, 'success');
  });

  $('settingsAutoDelete').addEventListener('change', async (e) => {
    await api.setAutoDelete(e.target.checked);
    toast(e.target.checked ? 'Auto-delete enabled' : 'Auto-delete disabled');
  });

  $('settingsCleanup').addEventListener('click', async () => {
    const r = await api.cleanupNow();
    toast(r.removed > 0 ? `Removed ${r.removed} old messages` : 'Nothing to clean up');
    if (state.activeTab === 'chats') await refreshChats();
    if (state.activeTab === 'hub') await refreshHub();
  });

  $('settingsOpenFolder').addEventListener('click', () => api.openReceivedDir());

  $('displayNameBtn').addEventListener('click', async () => {
    document.querySelector('.tab[data-tab="settings"]').click();
    $('settingsName').focus();
    $('settingsName').select();
  });
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

async function startCall(peerIp, isVideo) {
  if (!peerIp) {
    toast('Pick a device first', 'error');
    return;
  }
  const r = await api.initiateCall(peerIp, isVideo);
  if (!r.ok) {
    toast('Could not start the call', 'error');
    return;
  }
  openCallOverlay(false);
}

function openCallOverlay(outgoing) {
  const s = state.snapshot;
  const call = (s && s.activeCall) || { callerName: 'Peer', isVideoCall: true };
  const overlay = $('callOverlay');
  overlay.classList.remove('hidden');

  $('callName').textContent = outgoing ? call.callerName : call.callerName;
  $('callState').textContent = outgoing ? 'Calling…' : 'Connecting…';
  $('callAvatar').textContent = initials(call.callerName);
  $('callAcceptBtn').classList.add('hidden');
  $('callPlaceholder').classList.remove('hidden');
  $('remoteVideoImg').classList.add('hidden');
  $('remoteVideo').classList.add('hidden');

  if (call.isVideoCall) startCamera();
}

function closeCallOverlay() {
  const overlay = $('callOverlay');
  if (overlay.classList.contains('hidden')) return;
  audio.stopCallTransmit();
  audio.stopVideo();
  audio.flushPlayback();
  if (state.callTimerHandle) {
    clearInterval(state.callTimerHandle);
    state.callTimerHandle = null;
  }
  overlay.classList.add('hidden');
}

async function startCamera() {
  const available = await audio.hasCamera();
  if (!available) {
    $('callPlaceholder').classList.remove('hidden');
    $('remoteVideo').classList.add('hidden');
    toast('No camera detected on this machine — continuing with audio only', 'info');
    return;
  }
  try {
    await audio.startVideo($('localVideo'));
    await api.setCallVideo(true);
  } catch (e) {
    // Say what actually went wrong instead of leaving a black box.
    $('callPlaceholder').classList.remove('hidden');
    $('remoteVideo').classList.add('hidden');
    toast(`Camera unavailable: ${e.message}`, 'error');
  }
}

function setupCalls() {
  $('incomingAccept').addEventListener('click', async () => {
    await api.acceptCall();
    $('incomingBanner').classList.add('hidden');
  });

  $('incomingDecline').addEventListener('click', () => api.declineCall());

  $('callEndBtn').addEventListener('click', async () => {
    await api.endCall();
    closeCallOverlay();
  });

  $('callMicBtn').addEventListener('click', async () => {
    const muted = !(state.snapshot && state.snapshot.callMicMuted);
    await api.setCallMic(muted);
    audio.setCallMuted(muted);
    $('callMicBtn').classList.toggle('off', muted);
  });

  $('callVideoBtn').addEventListener('click', async () => {
    const enabled = !(state.snapshot && state.snapshot.callVideoEnabled);
    await api.setCallVideo(enabled);
    if (enabled) startCamera();
    else audio.stopVideo();
    $('callVideoBtn').classList.toggle('off', !enabled);
  });

  api.onCallAudio((base64) => {
    if (state.snapshot && state.snapshot.activeCall) audio.pushCallPlayback(base64);
  });

  api.onCallVideo((base64) => {
    const img = $('remoteVideoImg');
    img.src = `data:image/jpeg;base64,${base64}`;
    img.classList.remove('hidden');
    $('callPlaceholder').classList.add('hidden');
    state.lastRemoteFrameAt = Date.now();
  });

  // Call clock + remote frame watchdog.
  setInterval(() => {
    const s = state.snapshot;
    if (!s || !s.activeCall) {
      closeCallOverlay();
      return;
    }
    // NOTE: the overlay must be shown regardless of which tab is active. An
    // earlier `if (state.activeTab === 'radio') return;` guard meant that a call
    // arriving while the user sat on the (default) Walkie-Talkie tab never opened
    // the call UI at all - so the camera was never started and the call looked
    // dead. A call has to interrupt whatever the user was doing.

    if ($('callOverlay').classList.contains('hidden')) openCallOverlay(!!s.activeCall.outgoing);

    const started = state.callStartedAt || (state.callStartedAt = Date.now());
    const secs = Math.floor((Date.now() - started) / 1000);
    $('callTimer').textContent =
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

    $('callState').textContent = s.activeCall.outgoing ? 'Calling…' : 'In call';
    $('callName').textContent = s.activeCall.callerName;

    // If frames stop arriving the remote picture is stale: hide it again.
    if (state.lastRemoteFrameAt && Date.now() - state.lastRemoteFrameAt > 4000) {
      $('remoteVideoImg').classList.add('hidden');
      $('callPlaceholder').classList.remove('hidden');
    }

    if (!audio.callTap || !audio.callTapActive) {
      audio.startCallTransmit(s.callMicMuted).catch((e) => toast(e.message, 'error'));
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * A refresh must never fail silently: if it throws, the user is left staring at a
 * stale list and the error vanishes into an unhandled rejection.
 */
function guard(promise, what) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch((e) => {
      console.error('[' + what + '] failed:', e);
      toast('Could not refresh ' + what + ': ' + (e && e.message ? e.message : e), 'error');
    });
  }
  return promise;
}

function applySnapshot(snapshot) {
  const previousTab = state.activeTab;
  state.snapshot = snapshot;
  renderHeader();
  renderPeerLists();
  updateChannelStatus();

  if (state.activeTab === 'hub') guard(refreshHub(), 'broadcast');
  else if (state.activeTab === 'chats') guard(refreshChats(), 'chats');
  else if (state.activeTab === 'settings') guard(refreshSettings(), 'settings');

  // Something arrived. If the user is not already looking at that conversation,
  // surface it instead of silently filing it away.
  announceIncoming(snapshot);

  // Leaving a call screen while a call is up tears the overlay down -- but never
// while a call is actually active, or switching tabs would kill the call UI.
  if (!(snapshot && snapshot.activeCall)
      && previousTab !== 'chats' && previousTab !== 'hub') closeCallOverlay();
}

/**
 * React to an inbound text/file the first time we see it.
 *
 * Previously the message was received and stored correctly, but if the user sat
 * on the Walkie-Talkie (or Settings) tab nothing on screen changed and it looked
 * as though the message had never arrived.
 */
function announceIncoming(snapshot) {
  const inc = snapshot && snapshot.lastIncoming;
  if (!inc || !inc.id) return;
  if (state.lastIncomingId === inc.id) return;
  state.lastIncomingId = inc.id;

  const isGlobal = inc.chatId === 'GLOBAL';
  const viewingIt = isGlobal
    ? state.activeTab === 'hub'
    : state.activeTab === 'chats' && state.activeChatId === inc.chatId;

  if (!viewingIt) {
    const what = inc.kind === 'file' ? 'sent a file' : 'sent a message';
    toast(`${inc.senderName} ${what}`, 'info');
  }

  // Keep the underlying data warm so switching tabs shows it immediately.
  if (isGlobal) guard(refreshHub(), 'broadcast');
  else guard(refreshChats(), 'chats');
}

async function boot() {
  setupTabs();
  initWaveform();
  setupWalkie();
  setupHub();
  setupChats();
  setupSettings();
  setupCalls();

  // Any pointer interaction unlocks the audio context in Chromium.
  window.addEventListener('pointerdown', () => audio.ensureContext().catch(() => {}));

  api.onState((snapshot) => {
    if (snapshot) applySnapshot(snapshot);
  });

  const initial = await api.getState();
  if (initial) applySnapshot(initial);
  await refreshHub();
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    console.error(e);
    toast(`Startup failed: ${e.message}`, 'error');
  });
});