// Graph wiring test with a mock Web Audio implementation.
import test from "node:test";
import assert from "node:assert";

let counter = 0;
class Param {
  constructor(v = 1) { this.value = v; }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
}
class MockNode {
  constructor(type) { this.type = type; this.id = `${type}#${counter++}`; this.out = []; this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); }
  connect(node) { this.out.push(node); return node; }
  disconnect(node) { this.out = node ? this.out.filter(n => n !== node) : []; }
}
class MockContext {
  constructor() { this.currentTime = 0; this.state = "running"; this.destination = new MockNode("speakers"); this.audioWorklet = { addModule: async () => {} }; }
  createGain() { return new MockNode("gain"); }
  createBiquadFilter() { return new MockNode("biquad"); }
  createWaveShaper() { return new MockNode("shaper"); }
  createAnalyser() { return new MockNode("analyser"); }
  createMediaStreamDestination() { const n = new MockNode("streamDest"); n.stream = { id: n.id }; return n; }
  createMediaStreamSource(stream) { const n = new MockNode("streamSource"); n.stream = stream; return n; }
  async resume() {}
  async close() {}
  async setSinkId(id) { this.sinkId = id; }
}
globalThis.AudioWorkletNode = class extends MockNode {
  constructor(_ctx, name) {
    super(name);
    this.port = {};
    this.parameters = new Map([["enabled", new Param(1)], ["ceiling", new Param(0.89)], ["release", new Param(0.08)]]);
  }
};
globalThis.URL.createObjectURL = () => "blob:x";
globalThis.URL.revokeObjectURL = () => {};

const { MixerEngine, BUS_IDS } = await import("../src/renderer/engine/engine.js");

function paths(from, to, acc = [], out = []) {
  if (from === to) out.push([...acc, from.type]);
  else from.out.forEach(n => paths(n, to, [...acc, from.type], out));
  return out;
}

const cfg = (over = {}) => ({
  deviceId: "x", label: "X", enabled: true, gainDb: 0, mute: false, solo: false, forceMono: false,
  sends: { monitor: { on: true, levelDb: 0 }, monitor2: { on: false, levelDb: 0 }, output: { on: true, levelDb: -6 } },
  ...over
});

test("every strip reaches every bus through EQ, drive, fader, soft clip, limiter", async () => {
  const engine = new MixerEngine({ AudioContextCtor: MockContext });
  await engine.init();
  for (const strip of engine.strips) {
    for (const id of BUS_IDS) {
      const found = paths(strip.input, engine.buses[id].destination);
      assert.ok(found.length >= 2, "stereo and mono paths");
      for (const p of found) {
        const chain = p.join(">");
        assert.match(chain, /^(gain>){6,7}lowshelf>peaking>highshelf>gain>gain>gain>shaper>lookahead-limiter>streamDest$/, chain);
      }
    }
  }
});

test("app nodes and device streams feed the same strip input", async () => {
  const engine = new MixerEngine({ AudioContextCtor: MockContext });
  await engine.init();
  const appNode = new MockNode("app-pcm-player");
  engine.setStripNode(0, appNode);
  assert.ok(appNode.out.includes(engine.strips[0].input));
  engine.setStripStream(0, { id: "mic" });
  assert.ok(!appNode.out.includes(engine.strips[0].input), "app node detached from strip");
  assert.equal(engine.strips[0].source.type, "streamSource");
  assert.ok(engine.strips[0].source.out.includes(engine.strips[0].input));
});

test("gain, mute, solo, mono and sends", async () => {
  const engine = new MixerEngine({ AudioContextCtor: MockContext });
  await engine.init();
  const active = { monitor: true, monitor2: true, output: false };
  engine.setStripParams(0, cfg({ gainDb: 24, forceMono: true }), active);
  const s = engine.strips[0];
  assert.ok(Math.abs(s.trim.gain.value - 15.85) < 0.01, "+24 dB boost");
  assert.equal(s.monoPath.gain.value, 1);
  assert.equal(s.stereoPath.gain.value, 0);
  assert.equal(s.sends.monitor.gain.value, 1);
  assert.equal(s.sends.monitor2.gain.value, 0, "send off");
  assert.equal(s.sends.output.gain.value, 0, "bus without device is silent");
  assert.equal(s.muteGain.gain.value, 1);

  engine.setStripParams(0, cfg({ mute: true }), active);
  assert.equal(s.muteGain.gain.value, 0);

  engine.soloActive = true;
  engine.setStripParams(0, cfg({ solo: false }), active);
  engine.setStripParams(1, cfg({ solo: true }), active);
  assert.equal(engine.strips[0].muteGain.gain.value, 0, "non-soloed strip silenced");
  assert.equal(engine.strips[1].muteGain.gain.value, 1);
});

test("master processing + bus params + sinks", async () => {
  const engine = new MixerEngine({ AudioContextCtor: MockContext });
  await engine.init();
  engine.setMasterProcessing({ eq: { low: 3, mid: 0, high: -2 }, driveDb: 6, softClip: { enabled: true, thresholdDb: -6 }, limiter: { enabled: false, ceilingDb: -3 } });
  const bus = engine.buses.monitor;
  assert.equal(bus.eqLow.gain.value, 3);
  assert.ok(Math.abs(bus.drive.gain.value - 1.995) < 0.01);
  assert.equal(bus.clipPre.gain.value, 1 / 8);
  assert.equal(bus.shaper.oversample, "4x");
  assert.ok(bus.shaper.curve instanceof Float32Array);
  assert.equal(bus.limiter.parameters.get("enabled").value, 0);
  engine.setMasterProcessing({ softClip: { enabled: false, thresholdDb: -6 } });
  assert.equal(bus.shaper.curve, null);
  assert.equal(bus.clipPre.gain.value, 1);

  engine.setBusParams("monitor", { volumeDb: -6, mute: false, active: true });
  assert.ok(Math.abs(bus.fader.gain.value - 0.501) < 0.01);
  engine.setBusParams("monitor", { volumeDb: 0, mute: true, active: true });
  assert.equal(bus.fader.gain.value, 0);

  // first active bus plays straight from the engine context (one clock domain)
  let errors = await engine.setOutputs({ monitor: "headphones", monitor2: "", output: "cable" });
  assert.deepEqual(errors, {});
  assert.equal(engine.ctx.sinkId, "headphones");
  assert.equal(engine.buses.monitor.direct.gain.value, 1);
  assert.equal(engine.outputs.monitor, undefined, "no bridge for the primary bus");
  assert.equal(engine.buses.output.direct.gain.value, 0);
  assert.equal(engine.outputs.output.ctx.sinkId, "cable");
  assert.equal(engine.outputs.output.source.stream, engine.buses.output.destination.stream);
  // turning the primary off promotes the next bus and closes the idle bridge
  errors = await engine.setOutputs({ monitor: "", monitor2: "", output: "cable" });
  assert.equal(engine.ctx.sinkId, "cable");
  assert.equal(engine.buses.output.direct.gain.value, 1);
  assert.equal(engine.buses.monitor.direct.gain.value, 0);
  assert.equal(engine.outputs.output, undefined);
  await engine.close();
  assert.equal(engine.ctx, null);
});
