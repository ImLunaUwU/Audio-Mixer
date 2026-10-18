import test from "node:test";
import assert from "node:assert";
import * as dsp from "../src/renderer/engine/dsp.js";

test("fader taper round-trips and hits unity at 75%", () => {
  for (const maxDb of [24, 12]) {
    assert.equal(dsp.faderPosToDb(dsp.UNITY_POS, maxDb), 0);
    assert.equal(dsp.faderPosToDb(1, maxDb), maxDb);
    assert.equal(dsp.faderPosToDb(0, maxDb), dsp.MIN_DB);
    for (const db of [-50, -24, -6, -0.5, 0, 3, maxDb]) {
      assert.ok(Math.abs(dsp.faderPosToDb(dsp.dbToFaderPos(db, maxDb), maxDb) - db) < 1e-9, `${db} @ ${maxDb}`);
    }
  }
  // monotonic
  let prev = -Infinity;
  for (let p = 0; p <= 1; p += 0.01) {
    const db = dsp.faderPosToDb(p, 24);
    assert.ok(db >= prev);
    prev = db;
  }
});

test("dB conversions", () => {
  assert.equal(dsp.dbToGain(0), 1);
  assert.equal(dsp.dbToGain(-60), 0);
  assert.ok(Math.abs(dsp.dbToGain(24) - 15.85) < 0.01);
  assert.ok(Math.abs(dsp.gainToDb(0.5) + 6.02) < 0.01);
  assert.equal(dsp.formatDb(-60), "-∞ dB");
  assert.equal(dsp.formatDb(3), "+3.0 dB");
  assert.equal(dsp.formatDb(-0.01), "0.0 dB");
});

test("soft clip: unity below knee, monotonic, never exceeds 0 dBFS", () => {
  const curve = dsp.buildSoftClipCurve(-6);
  const shape = x => dsp.applyCurve(curve, x / dsp.SOFT_CLIP_RANGE);
  assert.ok(Math.abs(shape(0.3) - 0.3) < 1e-3);
  assert.ok(Math.abs(shape(-0.3) + 0.3) < 1e-3);
  let prev = -Infinity;
  for (let x = -8; x <= 8; x += 0.01) {
    const y = shape(x);
    assert.ok(y >= prev - 1e-6, "monotonic");
    assert.ok(Math.abs(y) <= 1.0000001, `bounded at ${x}`);
    prev = y;
  }
  assert.ok(shape(1.5) > 0.95 && shape(1.5) < 1);
});

test("meter measurement + ballistics", () => {
  const block = new Float32Array(1024).map((_, i) => Math.sin(i / 10));
  const { peakDb, rmsDb } = dsp.measureBlock(block);
  assert.ok(Math.abs(peakDb) < 0.1);
  assert.ok(Math.abs(rmsDb + 3.01) < 0.2);
  assert.equal(dsp.decayMeter(-10, -5, 0.1), -5);
  assert.equal(dsp.decayMeter(-10, -60, 0.1, 20), -12);
});

test("cable descriptors + channel inference", () => {
  assert.deepEqual(dsp.getCableDescriptor("CABLE Output (VB-Audio Virtual Cable)"), { familyKey: "cable:default", side: "output" });
  assert.deepEqual(dsp.getCableDescriptor("CABLE-A Input (VB-Audio Cable A)"), { familyKey: "cable:a", side: "input" });
  assert.equal(dsp.getCableDescriptor("Speakers"), null);
  assert.equal(dsp.inferChannelsFromLabel("Speakers (7.1 Surround)"), 6);
  assert.equal(dsp.inferChannelsFromLabel("Mic (2ch)"), 2);
});
