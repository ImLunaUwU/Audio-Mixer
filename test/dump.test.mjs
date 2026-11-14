import test from "node:test";
import assert from "node:assert";
import { resolveDumpDevice, dumpDeviceOptions, dumpDeviceConflicts, buildDumpRequest, normalizeDeviceName } from "../src/renderer/dump.js";

// Windows render endpoints as AppRouter.exe lists them (UwU-like setup).
const devices = [
  { id: "{0.0.0.00000000}.{aaaaaaaa-0000-0000-0000-000000000001}", name: "Headphones (Arctis)", isDefault: true },
  { id: "{0.0.0.00000000}.{bbbbbbbb-0000-0000-0000-000000000002}", name: "Line 1 (Virtual Audio Cable)", isDefault: false },
  { id: "{0.0.0.00000000}.{cccccccc-0000-0000-0000-000000000003}", name: "Line 2 (Virtual Audio Cable)", isDefault: false },
  { id: "{0.0.0.00000000}.{dddddddd-0000-0000-0000-000000000004}", name: "CABLE Input (VB-Audio Virtual Cable)", isDefault: false },
  { id: "{0.0.0.00000000}.{eeeeeeee-0000-0000-0000-000000000005}", name: "Steam Streaming Speakers", isDefault: false }
];
const [hp, line1, line2, vb, steam] = devices;
const busLabels = { monitor: "Headphones (Arctis)", monitor2: "", output: "Line 1 (Virtual Audio Cable)" };

test("nothing is picked automatically: unset by default", () => {
  const t = resolveDumpDevice({ devices, busLabels, chosen: { id: "", name: "" } });
  assert.equal(t.state, "unset");
  assert.equal(t.id, "");
  assert.match(t.message, /Settings > Dump device/);
  assert.equal(resolveDumpDevice({ devices }).state, "unset");
});

test("a free device the user chose is used as-is, by endpoint id", () => {
  const t = resolveDumpDevice({ devices, busLabels, chosen: { id: steam.id, name: "old name" } });
  assert.equal(t.state, "ok");
  assert.equal(t.id, steam.id);
  assert.equal(t.name, "Steam Streaming Speakers");
});

test("the MIX output device is allowed but warned about (the old auto-pick bug)", () => {
  const t = resolveDumpDevice({ devices, busLabels, chosen: { id: line1.id } });
  assert.equal(t.state, "warn");
  assert.equal(t.id, line1.id);
  assert.match(t.message, /MIX/);
});

test("Windows default device is warned about", () => {
  const t = resolveDumpDevice({ devices, busLabels: {}, chosen: { id: hp.id } });
  assert.equal(t.state, "warn");
  assert.ok(t.conflicts.some(c => c.kind === "default"));
});

test("a render device whose capture side is a mixer input is warned about", () => {
  // Virtual Audio Cable: same friendly name on both sides.
  const vac = dumpDeviceConflicts(line2, { inputLabels: ["Line 2 (Virtual Audio Cable)"] });
  assert.deepEqual(vac.map(c => c.kind), ["input"]);
  // VB-CABLE: "CABLE Input" (render) feeds "CABLE Output" (capture).
  const vbc = dumpDeviceConflicts(vb, { inputLabels: ["CABLE Output (VB-Audio Virtual Cable)"] });
  assert.deepEqual(vbc.map(c => c.kind), ["input"]);
  assert.deepEqual(dumpDeviceConflicts(line2, { inputLabels: ["Microphone (Arctis)"] }), []);
});

test("Chromium label prefixes and USB suffixes still match the Windows name", () => {
  assert.equal(normalizeDeviceName("Default - Headphones (Arctis) (1038:12ad)"), "headphones (arctis)");
  const t = resolveDumpDevice({ devices, busLabels: { monitor: "Headphones (Arctis) (1038:12ad)" }, chosen: { id: hp.id } });
  assert.ok(t.conflicts.some(c => c.kind === "bus"));
});

test("a chosen device that is not connected is an error and dumps nothing", () => {
  const t = resolveDumpDevice({ devices, busLabels, chosen: { id: "{0.0.0.00000000}.{gone}", name: "USB Dongle" } });
  assert.equal(t.state, "missing");
  assert.equal(t.id, "");
  assert.match(t.message, /USB Dongle/);
});

test("picker lists every render device with conflict tags and splits duplicate names", () => {
  const dup = { id: "{0.0.0.00000000}.{ffffffff-0000-0000-0000-000000000006}", name: "Line 1 (Virtual Audio Cable)", isDefault: false };
  const opts = dumpDeviceOptions([...devices, dup], { busLabels, inputLabels: [] });
  assert.equal(opts.length, 6);
  assert.match(opts[0].label, /Windows default/);
  assert.match(opts[0].label, /used by the mixer/);
  assert.equal(opts[1].label, "Line 1 (Virtual Audio Cable) [bbbbbbbb] (used by the mixer)");
  assert.equal(opts[5].label, "Line 1 (Virtual Audio Cable) [ffffffff] (used by the mixer)");
  assert.equal(opts[4].label, "Steam Streaming Speakers");
  assert.ok(opts.every(o => !o.label.includes("\u2014") && !o.title.includes("\u2014")));
});

test("dump request only includes enabled app inputs with DUMP on", () => {
  const apps = [{ deviceId: "app:10", pid: "10", exeName: "Spotify.exe" }, { deviceId: "app:20", pid: "20", exeName: "Discord.exe" }];
  const inputs = [
    { deviceId: "app:10", enabled: true, dump: true },
    { deviceId: "app:20", enabled: false, dump: true },
    { deviceId: "mic", enabled: true, dump: true }
  ];
  assert.deepEqual(buildDumpRequest({ inputs, apps, targetId: steam.id }), { targetId: steam.id, items: [{ exeName: "Spotify.exe", pid: "10" }] });
});
