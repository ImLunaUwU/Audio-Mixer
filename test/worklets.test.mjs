import test from "node:test";
import assert from "node:assert";
import { WORKLET_SOURCES } from "../src/renderer/engine/worklets.js";

function loadProcessor(source, sampleRate = 48000) {
  let Processor;
  const scope = {
    sampleRate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: msg => (this.lastMessage = msg) }; } },
    registerProcessor: (_name, cls) => { Processor = cls; }
  };
  new Function(...Object.keys(scope), source)(...Object.values(scope));
  return Processor;
}

function runLimiter(limiter, signal, params) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i += 128) {
    const block = signal.subarray(i, i + 128);
    const L = new Float32Array(block.length), R = new Float32Array(block.length);
    limiter.process([[block, block]], [[L, R]], params);
    out.set(L, i);
  }
  return out;
}

const limiterParams = (ceilingDb, enabled = 1) => ({
  ceiling: [Math.pow(10, ceilingDb / 20)], release: [0.08], enabled: [enabled]
});

test("limiter: never exceeds ceiling on a +10 dB burst, and is transparent below it", () => {
  const Limiter = loadProcessor(WORKLET_SOURCES.LOOKAHEAD_LIMITER);
  const lim = new Limiter({ processorOptions: { lookahead: 0.003 } });
  const n = 48000;
  const signal = new Float32Array(n).map((_, i) => (i > 12000 && i < 24000 ? 3.16 : 0.3) * Math.sin(2 * Math.PI * 440 * i / 48000));
  const out = runLimiter(lim, signal, limiterParams(-1));
  const ceiling = Math.pow(10, -1 / 20);
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak}`);
  // before the burst: delayed unity passthrough
  const look = Math.round(48000 * 0.003);
  for (let i = 2000; i < 10000; i++) assert.ok(Math.abs(out[i] - signal[i - look]) < 1e-6);
  // gain reduction reported
  assert.ok(lim.lastMessage <= 0);
});

test("limiter: the clamp barely engages because gain arrives before the peak", () => {
  const Limiter = loadProcessor(WORKLET_SOURCES.LOOKAHEAD_LIMITER);
  const lim = new Limiter({ processorOptions: { lookahead: 0.003 } });
  const signal = new Float32Array(9600);
  signal[5000] = 4; // single huge spike
  const out = runLimiter(lim, signal, limiterParams(-1));
  const look = Math.round(48000 * 0.003);
  const ceiling = Math.pow(10, -1 / 20);
  assert.ok(Math.abs(out[5000 + look] - ceiling) < 1e-3, "spike limited to ceiling by gain, not clipped flat");
  assert.ok(lim.gain < 1);
});

test("limiter bypass passes signal through (delayed)", () => {
  const Limiter = loadProcessor(WORKLET_SOURCES.LOOKAHEAD_LIMITER);
  const lim = new Limiter({ processorOptions: { lookahead: 0.003 } });
  const signal = new Float32Array(4096).fill(2);
  const out = runLimiter(lim, signal, limiterParams(-1, 0));
  assert.equal(out[4000], 2);
});

function pcmBytes(frames, fn, startFrame = 0) {
  const b = new Uint8Array(frames * 4);
  const v = new DataView(b.buffer);
  for (let i = 0; i < frames; i++) {
    const [l, r] = fn(startFrame + i);
    v.setInt16(i * 4, l, true);
    v.setInt16(i * 4 + 2, r, true);
  }
  return b;
}

function newPlayer(rate = 48000, opts = {}) {
  const Player = loadProcessor(WORKLET_SOURCES.APP_PCM_PLAYER, rate);
  return new Player({ processorOptions: { inputRate: 48000, targetMs: 60, minTargetMs: 40, ...opts } });
}

function pull(p, blocks) {
  const out = [];
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    p.process([], [[L, R]]);
    out.push(...L);
  }
  return Float32Array.from(out);
}

test("jitter buffer: full-scale int16 decoded without clamping, frames split across messages", () => {
  const p = newPlayer();
  const bytes = pcmBytes(4800, i => [i % 2 ? 32767 : -32768, 16384]);
  // deliver in odd-sized pieces to split frames
  for (let i = 0; i < bytes.length; i += 333) p.push(bytes.subarray(i, i + 333));
  assert.equal(p.fill, 4800);
  assert.equal(p.left[0], -1);
  assert.ok(Math.abs(p.left[1] - 32767 / 32768) < 1e-9);
  assert.equal(p.right[123], 0.5);
});

test("jitter buffer: waits for target, then plays with a fade-in (no click)", () => {
  const p = newPlayer();
  p.push(pcmBytes(1000, () => [16384, 16384]));
  let out = pull(p, 2);
  assert.ok(out.every(v => v === 0), "still buffering below 60 ms");
  p.push(pcmBytes(3000, () => [16384, 16384]));
  out = pull(p, 4);
  assert.ok(out[0] < 0.01, "starts from silence");
  assert.ok(Math.abs(out[out.length - 1] - 0.5) < 1e-6, "reaches full level");
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.01, "smooth ramp");
});

test("jitter buffer: absorbs clock drift by resampling, no dropouts", () => {
  // producer clock 0.2 % fast and delivering in bursty 10 ms chunks with jitter
  const p = newPlayer();
  let produced = 0, t = 0;
  const sine = i => { const v = Math.round(12000 * Math.sin(i / 20)); return [v, v]; };
  for (let block = 0; block < 48000 * 30 / 128; block++) {
    t += 128 / 48000;
    const due = Math.floor(t * 48000 * 1.002);
    while (produced + 480 <= due + (block % 7 === 0 ? 480 : 0)) {
      p.push(pcmBytes(480, sine, produced));
      produced += 480;
    }
    pull(p, 1);
  }
  assert.equal(p.underruns, 0);
  const fillMs = p.fill / 48;
  assert.ok(fillMs > 30 && fillMs < 130, `buffer stays near target (${fillMs.toFixed(1)} ms)`);
  assert.ok(p.rate > 1.0005, "playback sped up slightly to follow the fast producer");
});

test("jitter buffer: underrun fades out, grows target, recovers with a fade-in", () => {
  const p = newPlayer();
  const tone = () => [16384, 16384];
  p.push(pcmBytes(3000, tone));
  pull(p, 10);
  const before = p.target;
  const out = pull(p, 30); // starve it
  assert.equal(p.underruns, 1);
  assert.ok(p.target > before, "target grew");
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.02, `no click at ${i}`);
  p.push(pcmBytes(10000, tone));
  const resumed = pull(p, 10);
  assert.ok(resumed[0] < 0.01 && Math.abs(resumed[resumed.length - 1] - 0.5) < 1e-6);
});

test("jitter buffer: overflow after a stall skips ahead with a crossfade", () => {
  const p = newPlayer();
  p.push(pcmBytes(3000, () => [8000, 8000]));
  pull(p, 10);
  p.push(pcmBytes(48000, () => [8000, 8000])); // 1 s burst
  const out = pull(p, 20);
  assert.ok(p.fill / 48 < 120, `latency bounded (${p.fill / 48} ms)`);
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.02);
});

test("jitter buffer works at 44.1 kHz output", () => {
  const p = newPlayer(44100);
  p.push(pcmBytes(4800, () => [16384, -16384]));
  const out = pull(p, 20);
  assert.ok(Math.abs(out[out.length - 1] - 0.5) < 1e-6);
});
