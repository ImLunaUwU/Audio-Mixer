import test from "node:test";
import assert from "node:assert";
import { migrateConfig, normalizeInput, LATENCY_HINTS, SYNC_OFFSET_MIN, SYNC_OFFSET_MAX } from "../src/renderer/config.js";
import { formatMs, syncTitle, syncInfoFor } from "../src/renderer/sync.js";

test("Ultra low preset is a valid saved value; old and unknown values still load", () => {
  assert.deepEqual(LATENCY_HINTS, ["ultra", "interactive", "balanced", "playback"]);
  assert.equal(migrateConfig({ latencyHint: "ultra" }).latencyHint, "ultra");
  for (const hint of ["interactive", "balanced", "playback"]) assert.equal(migrateConfig({ latencyHint: hint }).latencyHint, hint);
  assert.equal(migrateConfig({ latencyHint: "turbo" }).latencyHint, "balanced");
  assert.equal(migrateConfig({}).latencyHint, "balanced");
});

test("karaoke sync settings default on and survive migration", () => {
  const c = migrateConfig({ version: 4, inputs: [{ deviceId: "mic" }] });
  assert.equal(c.autoSync, true);
  assert.equal(c.inputs[0].syncOffsetMs, 0);
  assert.equal(migrateConfig({ autoSync: false }).autoSync, false);
  assert.equal(migrateConfig({ autoSync: "yes" }).autoSync, true);
  const again = migrateConfig(migrateConfig({ autoSync: false, inputs: [{ deviceId: "app:1", syncOffsetMs: 42.4 }] }));
  assert.equal(again.autoSync, false);
  assert.equal(again.inputs[0].syncOffsetMs, 42);
});

test("sync offsets are clamped and rounded", () => {
  assert.equal(normalizeInput({ syncOffsetMs: 9999 }).syncOffsetMs, SYNC_OFFSET_MAX);
  assert.equal(normalizeInput({ syncOffsetMs: -9999 }).syncOffsetMs, SYNC_OFFSET_MIN);
  assert.equal(normalizeInput({ syncOffsetMs: "12" }).syncOffsetMs, 0);
  assert.equal(normalizeInput({ syncOffsetMs: -12.6 }).syncOffsetMs, -13);
});

test("preset snapshots keep per-input sync offsets", () => {
  const c = migrateConfig({ presets: [{ name: "Karaoke", snapshot: { inputs: [{ deviceId: "app:1", syncOffsetMs: 30 }] } }] });
  assert.equal(c.presets[0].snapshot.inputs[0].syncOffsetMs, 30);
});

test("sync UI helpers", () => {
  assert.equal(formatMs(0), "0");
  assert.equal(formatMs(15), "+15");
  assert.equal(formatMs(-20), "-20");
  const title = syncTitle({ offsetMs: 10, delayMs: 55, auto: true });
  assert.match(title, /\+10 ms/);
  assert.match(title, /55 ms/);
  assert.match(title, /MIX only/);
  assert.deepEqual(syncInfoFor({ auto: true, mixDelayMs: [0, 45, 0] }, 1), { auto: true, delayMs: 45 });
  assert.deepEqual(syncInfoFor(null, 0), { auto: false, delayMs: 0 });
  assert.deepEqual(syncInfoFor({ mixDelayMs: ["x"] }, 0), { auto: false, delayMs: 0 });
});
