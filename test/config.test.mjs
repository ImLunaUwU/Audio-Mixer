import test from "node:test";
import assert from "node:assert";
import { migrateConfig, migrateDeviceStates, CONFIG_VERSION, linearToDb } from "../src/renderer/config.js";

const v3 = {
  version: 3,
  inputs: [
    { deviceId: "mic", monitorVolume: 0.5, monitor2Volume: 1, outputVolume: 1, monitorMute: false, monitor2Mute: true, outputMute: false, forceMono: true },
    { deviceId: "app:1234", monitorVolume: 0, outputVolume: 0.25, outputMute: true },
    {}
  ],
  monitorDeviceId: "hp", monitor2DeviceId: "default", mixedOutputDeviceId: "cable",
  monitorMasterVolume: 0.5, outputMasterVolume: 1,
  eq: { low: 3, mid: 0, high: -2 },
  overloadGain: 2,
  softClipEnabled: false, softClipThresholdDb: -9,
  compactMode: true,
  presets: [{ name: "Stream", snapshot: { inputs: [{ deviceId: "mic", monitorVolume: 1 }], monitorDeviceId: "hp", overloadGain: 1.5 } }, { name: 5 }],
  eqCustomPresets: [{ name: "Warm", values: { low: 4, mid: 1, high: 0 } }, { bad: true }]
};

test("migrates v3 config to v4", () => {
  const c = migrateConfig(v3);
  assert.equal(c.version, CONFIG_VERSION);
  assert.equal(c.inputs.length, 3);
  assert.equal(c.inputs[0].deviceId, "mic");
  assert.equal(c.inputs[0].forceMono, true);
  assert.equal(c.inputs[0].sends.monitor.levelDb, linearToDb(0.5));
  assert.equal(c.inputs[0].sends.monitor2.on, false);
  assert.equal(c.inputs[0].gainDb, 0);
  assert.equal(c.inputs[1].sends.monitor.levelDb, -60);
  assert.equal(c.inputs[1].sends.output.on, false);
  assert.equal(c.buses.monitor.deviceId, "hp");
  assert.equal(c.buses.monitor2.deviceId, "", "reserved ids dropped");
  assert.equal(c.buses.output.deviceId, "cable");
  assert.ok(Math.abs(c.buses.monitor.volumeDb - -6) < 0.1);
  assert.ok(Math.abs(c.driveDb - 6) < 0.1);
  assert.deepEqual(c.softClip, { enabled: false, thresholdDb: -9 });
  assert.deepEqual(c.limiter, { enabled: true, ceilingDb: -1 });
  assert.equal(c.compactMode, true);
  assert.equal(c.presets.length, 1);
  assert.equal(c.presets[0].snapshot.buses.monitor.deviceId, "hp");
  assert.ok(Math.abs(c.presets[0].snapshot.driveDb - 3.5) < 0.1);
  assert.equal(c.eqCustomPresets.length, 1);
});

test("migration is idempotent", () => {
  const once = migrateConfig(v3);
  const twice = migrateConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test("handles garbage and clamps values", () => {
  const c = migrateConfig({ inputs: "nope", driveDb: 99, limiter: { ceilingDb: 5 }, latencyHint: "turbo", window: { width: 10, height: 10 } });
  assert.equal(c.inputs.length, 3);
  assert.equal(c.driveDb, 12);
  assert.equal(c.limiter.ceilingDb, 0);
  assert.equal(c.latencyHint, "ultra");
  assert.equal(c.window.width, 760);
  assert.deepEqual(migrateConfig(null).inputs, migrateConfig(undefined).inputs);
});

test("v1 legacy bassGain becomes eq.low", () => {
  assert.equal(migrateConfig({ bassGain: 4 }).eq.low, 4);
});

test("device states migrate from old flat shape", () => {
  const states = migrateDeviceStates({ mic: { monitorVolume: 0.5, outputMute: true, label: "Mic" }, "": {}, bad: null });
  assert.deepEqual(Object.keys(states), ["mic"]);
  assert.equal(states.mic.label, "Mic");
  assert.equal(states.mic.sends.output.on, false);
});

test("DUMP defaults off, migrates from the old hide keys, dump device defaults unset", () => {
  const c = migrateConfig({ inputs: [{ deviceId: "app:1", hideFromWindows: true }, { hideFromWindows: "yes" }, { dump: true, hideFromWindows: false }], appRouting: { targetId: "{x}", targetLabel: "Line 2" } });
  assert.equal(c.inputs[0].dump, true);
  assert.equal(c.inputs[1].dump, false);
  assert.equal(c.inputs[2].dump, true);
  assert.ok(!("hideFromWindows" in c.inputs[0]));
  assert.ok(!("appRouting" in c));
  assert.deepEqual(c.dumpDevice, { id: "{x}", name: "Line 2" }, "an explicitly chosen device carries over");
  assert.deepEqual(migrateConfig({}).dumpDevice, { id: "", name: "" });
  // "Automatic" from early 2.0 builds becomes "not set", never an automatic pick.
  assert.deepEqual(migrateConfig({ appRouting: { targetId: "", targetLabel: "Line 1 (Virtual Audio Cable)" } }).dumpDevice, { id: "", name: "" });
  assert.deepEqual(migrateConfig({ dumpDevice: { id: "{y}", name: "Steam Streaming Speakers" }, appRouting: { targetId: "{x}" } }).dumpDevice, { id: "{y}", name: "Steam Streaming Speakers" });
  assert.equal(migrateDeviceStates({ "app-exe:spotify": { hideFromWindows: true, label: "Spotify" } })["app-exe:spotify"].dump, true);
});
