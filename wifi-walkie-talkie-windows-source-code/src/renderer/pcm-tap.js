'use strict';
/**
 * pcm-tap.js — AudioWorkletProcessor used by the walkie-talkie and call audio paths.
 *
 * This lives in its own file (rather than being built from a Blob at runtime) so it
 * is fetched as a same-origin module. That keeps the renderer Content-Security-Policy
 * strict (`script-src 'self'`) — a `blob:` URL would be refused by the policy and the
 * microphone would appear permanently unavailable.
 *
 * The processor accumulates 128-sample render quanta into fixed 1024-sample
 * (64 ms @ 16 kHz) frames and transfers them to the main thread as Float32Array.
 * It stays idle until the main thread posts `{type:'enabled', value:true}` so it
 * costs nothing while the push-to-talk button is not held.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameSize = opts.frameSize || 1024;
    this.enabled = false;
    this.buffer = new Float32Array(this.frameSize);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'enabled') this.enabled = !!event.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && this.enabled) {
      const samples = input[0];
      let offset = 0;
      while (offset < samples.length) {
        const space = this.frameSize - this.filled;
        const take = Math.min(space, samples.length - offset);
        this.buffer.set(samples.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled === this.frameSize) {
          // Copy: the render quantum buffer is reused by the audio thread.
          const out = new Float32Array(this.buffer);
          this.port.postMessage({ pcm: out }, [out.buffer]);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);