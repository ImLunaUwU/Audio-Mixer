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

test("app PCM player: full-scale int16 is not clamped and resampling works", () => {
  for (const rate of [48000, 44100]) {
    const Player = loadProcessor(WORKLET_SOURCES.APP_PCM_PLAYER, rate);
    const p = new Player({ processorOptions: { inputRate: 48000, targetLatency: 0.01, maxLatency: 0.12 } });
    const frames = 4800;
    const pcm = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) { pcm[2 * i] = i % 2 ? 32767 : -32768; pcm[2 * i + 1] = 16384; }
    p.push(pcm);
    const L = new Float32Array(128), R = new Float32Array(128);
    p.process([], [[L, R]]);
    assert.ok(Math.abs(R[10] - 0.5) < 1e-6, `right channel @${rate}`);
    if (rate === 48000) {
      assert.equal(L[0], -1);
      assert.ok(Math.abs(L[1] - 32767 / 32768) < 1e-9);
    }
    assert.ok(p.fill < frames);
  }
});

test("app PCM player bounds latency when the producer runs ahead", () => {
  const Player = loadProcessor(WORKLET_SOURCES.APP_PCM_PLAYER);
  const p = new Player({ processorOptions: { inputRate: 48000, targetLatency: 0.03, maxLatency: 0.12 } });
  p.push(new Int16Array(48000 * 2 * 0.3));
  assert.ok(p.fill <= 48000 * 0.12, `fill ${p.fill}`);
});
