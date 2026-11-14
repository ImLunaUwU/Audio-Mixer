import test from "node:test";
import assert from "node:assert";
import { migrateConfig, normalizeInput, cloneDefaults, LATENCY_HINTS, DEFAULT_LATENCY, CONFIG_VERSION } from "../src/renderer/config.js";

test("Ultra low is the default for new configs and unknown values", () => {
  assert.deepEqual(LATENCY_HINTS, ["ultra", "interactive", "balanced", "playback"]);
  assert.equal(DEFAULT_LATENCY, "ultra");
  assert.equal(cloneDefaults().latencyHint, "ultra");
  assert.equal(migrateConfig({}).latencyHint, "ultra");
  assert.equal(migrateConfig({ latencyHint: "turbo" }).latencyHint, "ultra");
});

test("old configs on the old default move to Ultra low; explicit choices are kept", () => {
  assert.equal(migrateConfig({ version: 4, latencyHint: "balanced" }).latencyHint, "ultra");
  assert.equal(migrateConfig({ version: 4, latencyHint: "interactive" }).latencyHint, "interactive");
  assert.equal(migrateConfig({ version: 4, latencyHint: "playback" }).latencyHint, "playback");
  // a v5 config that picked Balanced keeps it, also after migrating again
  const v5 = migrateConfig({ version: CONFIG_VERSION, latencyHint: "balanced" });
  assert.equal(v5.latencyHint, "balanced");
  assert.equal(migrateConfig(v5).latencyHint, "balanced");
});

test("configs saved by the karaoke sync test build still load (sync fields ignored)", () => {
  const c = migrateConfig({ version: 4, latencyHint: "ultra", autoSync: false, inputs: [{ deviceId: "app:1", syncOffsetMs: 40 }] });
  assert.equal(c.latencyHint, "ultra");
  assert.equal(c.inputs[0].deviceId, "app:1");
  assert.equal("autoSync" in c, false);
  assert.equal("syncOffsetMs" in c.inputs[0], false);
  assert.equal("syncOffsetMs" in normalizeInput({ syncOffsetMs: 12 }), false);
});
