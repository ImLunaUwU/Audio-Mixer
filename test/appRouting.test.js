const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAppRouter, parseTasklist, parseOutputs } = require("../src/main/appRouting");

const TARGET = "{0.0.0.00000000}.{SILENT}";
const PREVIOUS = "{0.0.0.00000000}.{SPEAKERS}";

function fakeRunner({ running = { "spotify.exe": ["10", "11"] }, persisted = {} } = {}) {
  const calls = [];
  const state = { running, persisted, calls };
  const exec = args => {
    calls.push(args.join(" "));
    if (args[0] === "list") return "1\t{a}\tHeadphones\n0\t{b}\tCABLE Input (VB-Audio Virtual Cable)\n";
    if (args[0] === "get") return `${state.persisted[args[1]] || ""}\n`;
    if (args[0] === "set") { args.slice(2).forEach(pid => { state.persisted[pid] = args[1] === "-" ? "" : args[1]; }); return ""; }
    throw new Error("bad command");
  };
  const procs = () => new Map(Object.entries(state.running));
  return {
    state,
    runner: { supported: true, helper: async args => exec(args), helperSync: exec, processes: async () => procs(), processesSync: procs }
  };
}

const tmpJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "am-route-")), "appRouting.json");
const silentLog = { error() {} };

test("parses helper and tasklist output", () => {
  const outputs = parseOutputs("1\t{a}\tHeadphones\r\n0\t{b}\tLine 2 (Virtual Audio Cable)\r\n\r\n");
  assert.deepEqual(outputs, [{ id: "{a}", name: "Headphones", isDefault: true }, { id: "{b}", name: "Line 2 (Virtual Audio Cable)", isDefault: false }]);
  const procs = parseTasklist('"Spotify.exe","10","Console","1","100 K"\r\n"spotify.exe","11","Console","1","5 K"\r\n"x.exe","2"');
  assert.deepEqual(procs.get("spotify.exe"), ["10", "11"]);
});

test("hides every process of the app and restores the previous device", async () => {
  const { runner, state } = fakeRunner({ persisted: { 10: PREVIOUS } });
  const journalPath = tmpJournal();
  const router = createAppRouter({ journalPath, runner, log: silentLog });
  const result = await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  assert.deepEqual(result, { hidden: ["spotify.exe"], errors: [] });
  assert.equal(state.persisted[10], TARGET);
  assert.equal(state.persisted[11], TARGET);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.entries["spotify.exe"].previous, PREVIOUS);

  // same request again does not spawn the helper
  const before = state.calls.length;
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  assert.equal(state.calls.length, before);

  // toggle off -> previous routing back, journal removed
  await router.sync({ targetId: TARGET, items: [] });
  assert.equal(state.persisted[10], PREVIOUS);
  assert.equal(state.persisted[11], PREVIOUS);
  assert.equal(fs.existsSync(journalPath), false);
});

test("default routing is restored by clearing, never by pinning a device", async () => {
  const { runner, state } = fakeRunner();
  const router = createAppRouter({ journalPath: tmpJournal(), runner, log: silentLog });
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  await router.restoreAll();
  assert.ok(state.calls.includes("set - 10 11"));
  assert.equal(state.persisted[10], "");
});

test("new processes of a hidden app get the target too", async () => {
  const { runner, state } = fakeRunner();
  const router = createAppRouter({ journalPath: tmpJournal(), runner, log: silentLog });
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  state.running["spotify.exe"] = ["10", "11", "12"];
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "12" }] });
  assert.equal(state.calls.at(-1), `set ${TARGET} 12`);
});

test("crash recovery: a journal left behind is undone when the app runs", async () => {
  const journalPath = tmpJournal();
  const first = fakeRunner({ running: {} , persisted: {} });
  fs.writeFileSync(journalPath, JSON.stringify({ version: 1, entries: { "spotify.exe": { exeName: "Spotify.exe", previous: PREVIOUS, target: TARGET } } }));
  const router = createAppRouter({ journalPath, runner: first.runner, log: silentLog });
  await router.restoreAll();
  assert.deepEqual(router.pending(), ["spotify.exe"], "kept until the app is running");
  first.state.running["spotify.exe"] = ["20"];
  await router.restoreAll();
  assert.equal(first.state.persisted[20], PREVIOUS);
  assert.deepEqual(router.pending(), []);
});

test("restoreAllSync restores on quit", async () => {
  const { runner, state } = fakeRunner();
  const journalPath = tmpJournal();
  const router = createAppRouter({ journalPath, runner, log: silentLog });
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  router.restoreAllSync();
  assert.equal(state.persisted[10], "");
  assert.equal(fs.existsSync(journalPath), false);
});

test("no target means nothing is hidden and earlier routing is undone", async () => {
  const { runner, state } = fakeRunner();
  const router = createAppRouter({ journalPath: tmpJournal(), runner, log: silentLog });
  await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  const result = await router.sync({ targetId: "", items: [{ exeName: "Spotify.exe", pid: "10" }] });
  assert.deepEqual(result.hidden, []);
  assert.equal(state.persisted[10], "");
});

test("helper failure is reported and leaves no journal entry", async () => {
  const { runner } = fakeRunner();
  runner.helper = async args => { if (args[0] === "set") throw new Error("AudioPolicyConfig activation failed (0x80040154)"); return "\n"; };
  const journalPath = tmpJournal();
  const router = createAppRouter({ journalPath, runner, log: silentLog });
  const result = await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  assert.equal(result.hidden.length, 0);
  assert.match(result.errors[0].message, /0x80040154/);
  assert.deepEqual(router.pending(), []);
});

test("unsupported platform reports an error instead of muting", async () => {
  const router = createAppRouter({ journalPath: tmpJournal(), runner: { supported: false }, log: silentLog });
  const result = await router.sync({ targetId: TARGET, items: [{ exeName: "Spotify.exe", pid: "10" }] });
  assert.equal(result.errors.length, 1);
});
