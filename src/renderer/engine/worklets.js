// AudioWorklet processors, registered from Blob URLs (works from file:// without
// extra protocol setup). Kept as strings so they run in the AudioWorkletGlobalScope.

// Adaptive jitter buffer for app-capture PCM (s16le stereo, 48 kHz).
//
// PCM arrives on a dedicated MessagePort straight from the main process (no hop
// through the renderer's main thread). The processor:
//  - buffers up to `target` ms before playing (target adapts: grows ×1.5 on every
//    underrun, shrinks slowly after 20 s without one, clamped to [min, 400] ms);
//  - corrects clock drift between the capture device and the output device by
//    nudging the playback rate (±0.5 % max, proportional to buffer error) instead of
//    dropping or inserting samples;
//  - on underrun fades out over the remaining samples, and fades back in on resume;
//  - if the buffer overflows (burst after a stall) it skips ahead with a crossfade;
//  - never allocates inside process() and never clamps (headroom is handled later).
// node.port receives control messages ({ type: "port", port } / { type: "config" })
// and posts stats ({ fillMs, targetMs, underruns, rate }) about once per second.
const APP_PCM_PLAYER = `
const CAP = 48000 * 2;           // 2 s ring
const FADE = 240;                // 5 ms fades
const XFADE = 256;               // skip-ahead crossfade
class AppPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.inRate = o.inputRate || 48000;
    this.baseRatio = this.inRate / sampleRate;
    this.left = new Float32Array(CAP);
    this.right = new Float32Array(CAP);
    this.write = 0; this.read = 0; this.fill = 0; this.frac = 0;
    this.carry = new Uint8Array(4); this.carryLen = 0;
    this.configure(o.targetMs || 60, o.minTargetMs || 30);
    this.playing = false; this.gain = 0; this.fadeDir = 0;
    this.avgFill = 0; this.underruns = 0; this.sinceUnderrun = 0;
    this.xfade = 0; this.xRead = 0; this.xFrac = 0;
    this.rate = this.baseRatio;
    this.statsEvery = sampleRate; this.statsCount = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m && m.type === "port") m.port.onmessage = ev => this.push(ev.data);
      else if (m && m.type === "config") this.configure(m.targetMs, m.minTargetMs);
      else if (m && (m.byteLength !== undefined)) this.push(m);
    };
  }
  configure(targetMs, minTargetMs) {
    this.minTarget = Math.round(this.inRate * (minTargetMs || 30) / 1000);
    this.target = Math.max(this.minTarget, Math.round(this.inRate * (targetMs || 60) / 1000));
    this.maxTarget = Math.round(this.inRate * 0.4);
  }
  pushFrame(l, r) {
    this.left[this.write] = l; this.right[this.write] = r;
    this.write = (this.write + 1) % CAP;
    if (this.fill < CAP) this.fill++; else this.read = (this.read + 1) % CAP;
  }
  push(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
    let i = 0;
    // complete a frame split across messages
    while (this.carryLen > 0 && this.carryLen < 4 && i < b.length) this.carry[this.carryLen++] = b[i++];
    if (this.carryLen === 4) {
      const c = this.carry;
      this.pushFrame(((c[0] | (c[1] << 8)) << 16 >> 16) / 32768, ((c[2] | (c[3] << 8)) << 16 >> 16) / 32768);
      this.carryLen = 0;
    }
    const end = b.length - ((b.length - i) % 4);
    for (; i < end; i += 4) {
      this.pushFrame(((b[i] | (b[i + 1] << 8)) << 16 >> 16) / 32768, ((b[i + 2] | (b[i + 3] << 8)) << 16 >> 16) / 32768);
    }
    for (; i < b.length; i++) this.carry[this.carryLen++] = b[i];
  }
  sample(buf, pos, frac) {
    const n = (pos + 1) % CAP;
    return buf[pos] + (buf[n] - buf[pos]) * frac;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    // smoothed buffer level drives drift correction
    this.avgFill += (this.fill - this.avgFill) * 0.01;

    if (!this.playing) {
      if (this.fill >= this.target) { this.playing = true; this.gain = 0; this.fadeDir = 1; this.avgFill = this.fill; }
      else { L.fill(0); if (R !== L) R.fill(0); this.stats(n); return true; }
    }

    // overflow after a stall: skip ahead to the target with a crossfade
    if (this.xfade === 0 && this.fill > this.target * 3 + n) {
      const skip = this.fill - this.target;
      this.xRead = this.read; this.xFrac = this.frac;
      this.read = (this.read + skip) % CAP;
      this.fill -= skip;
      this.xfade = XFADE;
      this.avgFill = this.fill;
    }

    const error = (this.avgFill - this.target) / this.target;
    const correction = Math.max(-0.005, Math.min(0.005, error * 0.004));
    this.rate = this.baseRatio * (1 + correction);

    for (let i = 0; i < n; i++) {
      if (this.fill < 3) {
        // underrun: fade what's left to silence and rebuffer with a larger target
        L[i] = 0; R[i] = 0;
        if (this.playing) {
          this.playing = false;
          this.underruns++;
          this.sinceUnderrun = 0;
          this.target = Math.min(this.maxTarget, Math.round(this.target * 1.5));
        }
        continue;
      }
      if (this.fadeDir !== 0) {
        this.gain += this.fadeDir / FADE;
        if (this.gain >= 1) { this.gain = 1; this.fadeDir = 0; }
      }
      // start fading out early if we are about to run dry
      if (this.fill < FADE && this.fadeDir === 0 && this.gain === 1) this.fadeDir = -1;
      if (this.fadeDir < 0 && this.gain <= 0) this.gain = 0;
      let l = this.sample(this.left, this.read, this.frac);
      let r = this.sample(this.right, this.read, this.frac);
      if (this.xfade > 0) {
        const t = this.xfade / XFADE;
        l = l * (1 - t) + this.sample(this.left, this.xRead, this.xFrac) * t;
        r = r * (1 - t) + this.sample(this.right, this.xRead, this.xFrac) * t;
        const xa = this.xFrac + this.rate, xw = Math.floor(xa);
        this.xFrac = xa - xw; this.xRead = (this.xRead + xw) % CAP;
        this.xfade--;
      }
      L[i] = l * this.gain; R[i] = r * this.gain;
      const adv = this.frac + this.rate, whole = Math.floor(adv);
      this.frac = adv - whole;
      this.read = (this.read + whole) % CAP;
      this.fill -= whole;
      if (this.fadeDir < 0 && this.fill >= FADE * 2) this.fadeDir = 1; // data arrived in time
    }
    this.sinceUnderrun += n;
    if (this.sinceUnderrun > sampleRate * 20 && this.target > this.minTarget) {
      this.target = Math.max(this.minTarget, Math.round(this.target * 0.9));
      this.sinceUnderrun = 0;
    }
    this.stats(n);
    return true;
  }
  stats(n) {
    this.statsCount += n;
    if (this.statsCount < this.statsEvery) return;
    this.statsCount = 0;
    this.port.postMessage({
      fillMs: Math.round(this.fill / this.inRate * 1000),
      targetMs: Math.round(this.target / this.inRate * 1000),
      underruns: this.underruns,
      rate: this.rate / this.baseRatio
    });
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
    if (!this.silence || this.silence.length !== n) this.silence = new Float32Array(n);
    const inL = input[0] || this.silence, inR = input[1] || inL;
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
      this.port.postMessage(this.minGr); // a number: no object allocation
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
