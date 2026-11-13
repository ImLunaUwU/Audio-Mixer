import test from "node:test";
import assert from "node:assert";
import { resolveRouteTarget, buildRoutingRequest } from "../src/renderer/routing.js";

const outputs = [
  { id: "hp", name: "Headphones (Arctis)", isDefault: true },
  { id: "l1", name: "Line 1 (Virtual Audio Cable)", isDefault: false },
  { id: "l2", name: "Line 2 (Virtual Audio Cable)", isDefault: false },
  { id: "vb", name: "CABLE Input (VB-Audio Virtual Cable)", isDefault: false }
];
const busLabels = { monitor: "Headphones (Arctis)", monitor2: "", output: "Line 1 (Virtual Audio Cable)" };

test("automatic target skips the default device and anything the mixer uses", () => {
  const t = resolveRouteTarget({ outputs, busLabels, inputLabels: [] });
  assert.equal(t.id, "l2");
  assert.equal(t.auto, true);
  assert.equal(t.level, "ok");
});

test("automatic target skips a cable whose other side is a mixer input", () => {
  const t = resolveRouteTarget({ outputs: outputs.filter(d => d.id !== "l2"), busLabels, inputLabels: ["CABLE Output (VB-Audio Virtual Cable)"] });
  assert.equal(t.id, "");
  assert.equal(t.level, "error");
  assert.match(t.warning, /No unused output/);
});

test("automatic target never picks a real speaker", () => {
  const t = resolveRouteTarget({ outputs: [outputs[0], { id: "tv", name: "LG TV (NVIDIA High Definition Audio)" }], busLabels: {} });
  assert.equal(t.id, "");
});

test("a chosen device that you listen to gets a warning", () => {
  const t = resolveRouteTarget({ outputs, busLabels, chosenId: "hp" });
  assert.equal(t.id, "hp");
  assert.equal(t.level, "warn");
  assert.match(t.warning, /Monitor 1/);
});

test("a chosen device that is gone is an error", () => {
  const t = resolveRouteTarget({ outputs, busLabels, chosenId: "gone" });
  assert.equal(t.id, "");
  assert.equal(t.level, "error");
});

test("routing request only includes enabled app inputs with Hide on", () => {
  const apps = [{ deviceId: "app:10", pid: "10", exeName: "Spotify.exe" }, { deviceId: "app:20", pid: "20", exeName: "Discord.exe" }];
  const inputs = [
    { deviceId: "app:10", enabled: true, hideFromWindows: true },
    { deviceId: "app:20", enabled: false, hideFromWindows: true },
    { deviceId: "mic", enabled: true, hideFromWindows: true }
  ];
  assert.deepEqual(buildRoutingRequest({ inputs, apps, targetId: "l2" }), { targetId: "l2", items: [{ exeName: "Spotify.exe", pid: "10" }] });
});
