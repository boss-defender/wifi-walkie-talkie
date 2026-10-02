'use strict';
/**
 * audio.js — Renderer-side Web Audio engine.
 *
 * Responsibilities:
 *   1. Capture the microphone at 16 kHz mono, convert to PCM signed-16 LE and
 *      hand the bytes to the main process for UDP transmission (walkie-talkie
 *      :9999 and call audio :8890).
 *   2. Play incoming PCM frames with a low-latency jitter buffer.
 *   3. Encode the camera into JPEG frames for the call video channel (:8889).
 *
 * All formats match the Android client byte for byte, so both platforms can
 * talk to each other.
 */

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1024;          // 64 ms @ 16 kHz
const MAX_JITTER_FRAMES = 12;        // ~770 ms before we start dropping
const MAX_VIDEO_FRAME_BYTES = 60000; // Android drops anything larger
const VIS_BARS = 16;                 // visualiser bar count (must match the canvas)

// The AudioWorklet processor is a separate same-origin module (pcm-tap.js). It is
// deliberately NOT built from a Blob: the renderer CSP is `script-src 'self'` with
// no `blob:` allowance, so a Blob URL would be blocked and the microphone would
// always report as unavailable.
const WORKLET_MODULE_URL = new URL('pcm-tap.js', window.location.href).href;

class AudioEngine {
  constructor(api) {
    this.api = api;
    this.ctx = null;
    this.workletLoaded = false;

    this.micStream = null;
    this.micSource = null;
    this.walkieTap = null;
    this.callTap = null;

    // Live signal levels for the transmission visualiser. `live*` tracks what we
    // are sending right now, `rx*` tracks the peer we are hearing.
    this.liveWaveform = new Array(VIS_BARS).fill(0.08);
    this.liveLevel = 0;
    this.rxWaveform = new Array(VIS_BARS).fill(0.08);
    this.rxLevel = 0;
    this.callWaveform = new Array(VIS_BARS).fill(0.08);
    this.callLevel = 0;

    // Playback
    this.playQueue = [];
    this.nextPlayTime = 0;
    this.playTimer = null;

    // Video
    this.camStream = null;
    this.videoEl = null;
    this.captureCanvas = null;
    this.captureTimer = null;
    this.videoFrameCount = 0;

    this.walkieFramesOut = 0;
    this.walkieFramesIn = 0;
    this.callFramesIn = 0;
    this.videoFramesIn = 0;
  }

  // ------------------------------------------------------------------
  // context
  // ------------------------------------------------------------------

  async ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API is unavailable');
      try {
        this.ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
      } catch (_e) {
        this.ctx = new Ctor();
      }
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_e) { /* needs a user gesture */ }
    }
    return this.ctx;
  }

  async ensureWorklet() {
    if (this.workletLoaded) return;
    const ctx = await this.ensureContext();
    await ctx.audioWorklet.addModule(WORKLET_MODULE_URL);
    this.workletLoaded = true;
  }

  // ------------------------------------------------------------------
  // microphone
  // ------------------------------------------------------------------

  async ensureMicrophone() {
    if (this.micStream) return this.micStream;
    const ctx = await this.ensureContext();
    await this.ensureWorklet();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone capture is unavailable');
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    this.micSource = ctx.createMediaStreamSource(this.micStream);

    // Worklet taps are kept inside the render graph via a muted gain node so
    // they keep processing even though we output nothing.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);

    this.walkieTap = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSize: FRAME_SAMPLES },
    });
    this.micSource.connect(this.walkieTap);
    this.walkieTap.connect(silent);
    this.walkieTap.port.onmessage = (event) => this._onCapturedFrame(event.data, 'walkie');

    this.callTap = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSize: FRAME_SAMPLES },
    });
    this.micSource.connect(this.callTap);
    this.callTap.connect(silent);
    this.callTap.port.onmessage = (event) => this._onCapturedFrame(event.data, 'call');

    return this.micStream;
  }

  _onCapturedFrame(data, channel) {
    if (!data || !data.pcm) return;
    const float = data.pcm;
    const pcm16 = this._floatToPcm16(float, this.ctx ? this.ctx.sampleRate : TARGET_SAMPLE_RATE);

    if (pcm16.length === 0) return;

    if (channel === 'walkie') {
      // Drive the transmission visualiser from the audio we are actually sending.
      this.liveWaveform = AudioEngine.waveformFromFloat(float, VIS_BARS);
      this.liveLevel = AudioEngine.levelFromFloat(float);
      this.walkieFramesOut += 1;
      this.api.sendWalkieAudio(this._toBase64(pcm16));
    } else if (channel === 'call') {
      this.callWaveform = AudioEngine.waveformFromFloat(float, VIS_BARS);
      this.callLevel = AudioEngine.levelFromFloat(float);
      this.api.sendCallAudio(this._toBase64(pcm16));
    }
  }

  /** Float32 [-1,1] @ `inputRate` -> Int16 PCM @ 16 kHz (linear resample if needed). */
  _floatToPcm16(float, inputRate) {
    let source = float;
    if (inputRate && inputRate !== TARGET_SAMPLE_RATE && inputRate > 0) {
      const ratio = inputRate / TARGET_SAMPLE_RATE;
      const outLength = Math.max(1, Math.floor(float.length / ratio));
      const resampled = new Float32Array(outLength);
      for (let i = 0; i < outLength; i++) {
        const srcPos = i * ratio;
        const i0 = Math.floor(srcPos);
        const i1 = Math.min(i0 + 1, float.length - 1);
        const t = srcPos - i0;
        resampled[i] = float[i0] * (1 - t) + float[i1] * t;
      }
      source = resampled;
    }

    const out = new Int16Array(source.length);
    for (let i = 0; i < source.length; i++) {
      let sample = source[i];
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out;
  }

  /** Int16 PCM @ 16 kHz -> Float32 @ context rate (for playback). */
  _pcm16ToFloat(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000;
    return out;
  }

  _resampleForPlayback(float) {
    const ctxRate = this.ctx ? this.ctx.sampleRate : TARGET_SAMPLE_RATE;
    if (ctxRate === TARGET_SAMPLE_RATE || !ctxRate) return float;
    const ratio = ctxRate / TARGET_SAMPLE_RATE;
    const outLength = Math.max(1, Math.floor(float.length * ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, float.length - 1);
      const t = srcPos - i0;
      out[i] = float[i0] * (1 - t) + float[i1] * t;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // walkie-talkie transmit / receive
  // ------------------------------------------------------------------

  async startWalkieTransmit() {
    await this.ensureMicrophone();
    this.walkieTap.port.postMessage({ type: 'enabled', value: true });
  }

  stopWalkieTransmit() {
    if (this.walkieTap) this.walkieTap.port.postMessage({ type: 'enabled', value: false });
  }

  /** Queue incoming walkie-talkie PCM for playback. */
  pushWalkiePlayback(base64) {
    this.walkieFramesIn += 1;
    // Feed the visualiser from the audio we are actually hearing.
    try {
      const int16 = this._fromBase64(base64);
      if (int16 && int16.length) {
        this.rxWaveform = AudioEngine.waveformFromInt16(int16, VIS_BARS);
        this.rxLevel = AudioEngine.levelFromFloat(
          Float32Array.from(int16, (v) => v / 32768),
        );
      }
    } catch (_e) { /* visualiser only */ }
    this._enqueuePlayback(base64);
  }

  // ------------------------------------------------------------------
  // call audio
  // ------------------------------------------------------------------

  async startCallTransmit(muted) {
    await this.ensureMicrophone();
    this.callTap.port.postMessage({ type: 'enabled', value: !muted });
  }

  stopCallTransmit() {
    if (this.callTap) this.callTap.port.postMessage({ type: 'enabled', value: false });
  }

  setCallMuted(muted) {
    if (this.callTap) this.callTap.port.postMessage({ type: 'enabled', value: !muted });
  }

  pushCallPlayback(base64) {
    this.callFramesIn += 1;
    this._enqueuePlayback(base64);
  }

  /** Drop any audio still queued (used when a call ends). */
  flushPlayback() {
    this.playQueue.length = 0;
    this.nextPlayTime = 0;
  }

  // ------------------------------------------------------------------
  // playback
  // ------------------------------------------------------------------

  _enqueuePlayback(base64) {
    if (!this.ctx) return;
    const int16 = this._fromBase64(base64);
    if (!int16 || int16.length === 0) return;

    let float = this._pcm16ToFloat(int16);
    float = this._resampleForPlayback(float);

    // If we fell far behind (tab throttling, packet burst) drop stale audio
    // rather than playing an ever-growing backlog.
    if (this.playQueue.length >= MAX_JITTER_FRAMES) {
      this.playQueue.splice(0, this.playQueue.length - MAX_JITTER_FRAMES + 1);
      this.nextPlayTime = 0;
    }

    this.playQueue.push(float);
    this._schedulePlayback();
  }

  _schedulePlayback() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

    const now = this.ctx.currentTime;
    if (this.nextPlayTime === 0 || this.nextPlayTime < now - 0.1) {
      this.nextPlayTime = now + 0.02;
    }

    while (this.playQueue.length > 0) {
      const float = this.playQueue.shift();
      const buffer = this.ctx.createBuffer(1, float.length, this.ctx.sampleRate);
      buffer.copyToChannel(float, 0);

      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.ctx.destination);
      node.start(this.nextPlayTime);
      this.nextPlayTime += buffer.duration;
    }
  }

  // ------------------------------------------------------------------
  // camera
  // ------------------------------------------------------------------

  async startVideo(videoElement) {
    this.videoEl = videoElement;
    const ctx = await this.ensureContext();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera capture is unavailable');
    }

    this.camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
    });

    videoElement.srcObject = this.camStream;
    videoElement.classList.remove('hidden');
    try {
      await videoElement.play();
    } catch (_e) { /* autoplay of a muted local stream is normally allowed */ }

    this.captureCanvas = document.createElement('canvas');
    this.captureCanvas.width = 480;
    this.captureCanvas.height = 360;
    this._startCaptureLoop();
    void ctx;
  }

  _startCaptureLoop() {
    const FPS = 12;
    this.captureTimer = setInterval(() => this._captureFrame(), Math.floor(1000 / FPS));
  }

  _captureFrame() {
    if (!this.camStream || !this.videoEl || !this.captureCanvas) return;
    const canvas = this.captureCanvas;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const w = this.videoEl.videoWidth || 480;
    const h = this.videoEl.videoHeight || 360;
    if (!w || !h) return;

    // Mirror the preview the way a selfie camera should look.
    ctx2d.save();
    ctx2d.translate(w, 0);
    ctx2d.scale(-1, 1);
    ctx2d.drawImage(this.videoEl, 0, 0, w, h);
    ctx2d.restore();

    canvas.toBlob((blob) => {
      if (!blob) return;
      if (blob.size >= MAX_VIDEO_FRAME_BYTES) return; // Android drops these too
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          const base64 = result.slice(result.indexOf(',') + 1);
          this.videoFrameCount += 1;
          this.api.sendCallVideo(base64);
        }
      };
      reader.onerror = () => {};
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.35);
  }

  stopVideo() {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.camStream) {
      for (const track of this.camStream.getTracks()) track.stop();
      this.camStream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.classList.add('hidden');
    }
    this.captureCanvas = null;
  }

  /**
   * True when the platform API exists AND a real capture device is present.
   *
   * The previous version only checked that `getUserMedia` existed, which is true
   * on essentially every machine, so a machine with no camera took the "camera
   * detected" path and then failed later with an opaque error. Enumerating first
   * lets us say "no camera found" instead of failing obscurely.
   */
  async hasCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === 'videoinput');
    } catch (_e) {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // base64 helpers (chunked to stay well under the argument size limit)
  // ------------------------------------------------------------------

  _toBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  _fromBase64(base64) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      // Int16Array requires a byte offset aligned to 2 bytes.
      return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    } catch (_e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // visualiser
  // ------------------------------------------------------------------

  /** Convert one PCM frame into 16 normalised bar heights. */
  static waveformFromFloat(float, bars = 16) {
    const out = new Array(bars).fill(0.08);
    const samples = float.length;
    if (samples === 0) return out;
    const chunkSize = Math.max(1, Math.floor(samples / bars));
    for (let b = 0; b < bars; b++) {
      const start = b * chunkSize;
      const end = Math.min(start + chunkSize, samples);
      let peak = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(float[i]);
        if (v > peak) peak = v;
      }
      out[b] = Math.min(1, Math.max(0.08, peak));
    }
    return out;
  }

  static waveformFromInt16(int16, bars = 16) {
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;
    return AudioEngine.waveformFromFloat(float, bars);
  }

  /**
   * Perceptual loudness of a frame, normalised to roughly 0..1.
   *
   * RMS is used rather than peak so that steady speech produces a steady
   * reading, then amplified and soft-clipped so normal talking reaches the top
   * of the visualiser without needing an unusually loud voice.
   */
  static levelFromFloat(float) {
    if (!float || float.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < float.length; i++) sum += float[i] * float[i];
    const rms = Math.sqrt(sum / float.length);
    return Math.min(1, rms * 3.2);
  }
}

window.AudioEngine = AudioEngine;