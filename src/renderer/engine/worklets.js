// AudioWorklet processors, registered from Blob URLs (works from file:// without
// extra protocol setup). Kept as strings so they run in the AudioWorkletGlobalScope.

// Plays raw interleaved s16le stereo PCM pushed via port.postMessage(ArrayBuffer).
// Ring buffer with bounded latency + linear resampling when the context isn't 48 kHz.
// Output is plain float (int16 / 32768), never clamped: headroom is handled downstream.
const APP_PCM_PLAYER = `
class AppPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    const rate = o.inputRate || 48000;
    this.ratio = rate / sampleRate;
    this.capacity = Math.ceil(rate * 0.5);
    this.target = Math.ceil(rate * (o.targetLatency || 0.03));
    this.maxFill = Math.ceil(rate * (o.maxLatency || 0.12));
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0; this.write = 0; this.fill = 0; this.frac = 0;
    this.primed = false;
    this.port.onmessage = e => this.push(new Int16Array(e.data));
  }
  push(s) {
    const frames = s.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.write] = s[2 * i] / 32768;
      this.right[this.write] = s[2 * i + 1] / 32768;
      this.write = (this.write + 1) % this.capacity;
      if (this.fill < this.capacity) this.fill++; else this.read = (this.read + 1) % this.capacity;
    }
    if (this.fill > this.maxFill) {
      const drop = this.fill - this.target;
      this.read = (this.read + drop) % this.capacity;
      this.fill -= drop;
    }
    if (!this.primed && this.fill >= this.target) this.primed = true;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      if (!this.primed || this.fill < 2) {
        L[i] = 0; R[i] = 0;
        if (this.fill < 2) this.primed = false;
        continue;
      }
      const n = (this.read + 1) % this.capacity, f = this.frac;
      L[i] = this.left[this.read] + (this.left[n] - this.left[this.read]) * f;
      R[i] = this.right[this.read] + (this.right[n] - this.right[this.read]) * f;
      const adv = f + this.ratio, whole = Math.floor(adv);
      this.frac = adv - whole;
      this.read = (this.read + whole) % this.capacity;
      this.fill = Math.max(0, this.fill - whole);
    }
    return true;
  }
}
registerProcessor("app-pcm-player", AppPcmPlayer);
`;

// Lookahead brickwall peak limiter. The signal is delayed by the lookahead window
// while the gain computer sees the future peak, so the gain is already down when the
// peak arrives (no overshoot, no hard clipping). Attack is spread over the lookahead,
// release is exponential. A final safety clamp catches inter-sample residue.
// AudioParams: ceiling (linear), release (seconds), enabled (0/1).
// Posts { gr } (gain reduction dB) ~30x/s for metering.
const LOOKAHEAD_LIMITER = `
class LookaheadLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ceiling", defaultValue: 0.891, minValue: 0.01, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.08, minValue: 0.005, maxValue: 2, automationRate: "k-rate" },
      { name: "enabled", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
    ];
  }
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.look = Math.max(1, Math.round(sampleRate * (o.lookahead || 0.003)));
    this.channels = 2;
    this.delay = [new Float32Array(this.look), new Float32Array(this.look)];
    this.pos = 0;
    this.gain = 1;
    // sliding-window minimum (monotonic deque of indices into an ever-increasing counter)
    // window covers the incoming sample and every delayed sample still in the line
    this.dqIdx = new Float64Array(this.look + 2);
    this.dqVal = new Float32Array(this.look + 2);
    this.dqHead = 0; this.dqTail = 0; this.counter = 0;
    this.minGr = 0; this.reportEvery = Math.round(sampleRate / 30); this.reportCount = 0;
  }
  pushMin(value) {
    const cap = this.look + 2;
    while (this.dqTail !== this.dqHead) {
      const last = (this.dqTail - 1 + cap) % cap;
      if (this.dqVal[last] >= value) this.dqTail = last; else break;
    }
    this.dqIdx[this.dqTail] = this.counter; this.dqVal[this.dqTail] = value;
    this.dqTail = (this.dqTail + 1) % cap;
    while (this.dqIdx[this.dqHead] < this.counter - this.look) this.dqHead = (this.dqHead + 1) % cap;
    this.counter++;
    return this.dqVal[this.dqHead];
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const n = output[0].length;
    const inL = input[0] || new Float32Array(n), inR = input[1] || inL;
    const outL = output[0], outR = output[1] || output[0];
    const enabled = params.enabled[0] >= 0.5;
    const ceiling = params.ceiling[0];
    const relCoef = Math.exp(-1 / (sampleRate * params.release[0]));
    const attackStep = 1 / this.look;
    for (let i = 0; i < n; i++) {
      const l = inL[i], r = inR[i];
      const peak = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      const required = enabled && peak > ceiling ? ceiling / peak : 1;
      const target = this.pushMin(required);
      if (target < this.gain) {
        // linear ramp that is guaranteed to reach the target within the lookahead window
        this.gain = Math.max(target, this.gain - (1 - target) * attackStep);
      } else {
        this.gain = target + (this.gain - target) * relCoef;
      }
      const dl = this.delay[0][this.pos], dr = this.delay[1][this.pos];
      this.delay[0][this.pos] = l; this.delay[1][this.pos] = r;
      this.pos = (this.pos + 1) % this.look;
      let ol = dl * this.gain, or = dr * this.gain;
      if (enabled) {
        if (ol > ceiling) ol = ceiling; else if (ol < -ceiling) ol = -ceiling;
        if (or > ceiling) or = ceiling; else if (or < -ceiling) or = -ceiling;
      }
      outL[i] = ol; outR[i] = or;
      if (this.gain < 1) { const gr = 20 * Math.log10(this.gain); if (gr < this.minGr) this.minGr = gr; }
    }
    this.reportCount += n;
    if (this.reportCount >= this.reportEvery) {
      this.port.postMessage(this.minGr);
      this.minGr = 0; this.reportCount = 0;
    }
    return true;
  }
}
registerProcessor("lookahead-limiter", LookaheadLimiter);
`;

export const WORKLET_SOURCES = { APP_PCM_PLAYER, LOOKAHEAD_LIMITER };

const loadedContexts = new WeakSet();

export async function loadWorklets(ctx) {
  if (loadedContexts.has(ctx)) return;
  for (const source of [APP_PCM_PLAYER, LOOKAHEAD_LIMITER]) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  loadedContexts.add(ctx);
}
