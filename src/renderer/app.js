// Renderer entry: owns state and wires the engine, sources, devices and UI together.
import "./tauriBridge.js";
import { MixerEngine, BUS_IDS } from "./engine/engine.js";
import { SourceManager, isAppSource } from "./engine/sources.js";
import { MeterChannel, MeterLoop } from "./engine/meters.js";
import { enumerateDevices, listApps, findReplacement, computeDisabledOptions, normalizeLabel } from "./devices.js";
import { createInputStrip, createBusStrip, BUS_LABELS } from "./ui/mixer.js";
import { initSettings } from "./ui/settings.js";
import { initPresets } from "./ui/presets.js";
import { initShortcuts, SHORTCUTS } from "./ui/shortcuts.js";
import { toast, setStatus, reportError } from "./ui/toast.js";
import { $, h, debounce } from "./ui/dom.js";
import { resolveDumpDevice, dumpDeviceOptions, buildDumpRequest } from "./dump.js";

const api = window.mixerAPI;
const APP_POLL_MS = 5000;

// "Latency / Stability" profiles. The Rust engine owns the numbers (input jitter buffer,
// secondary output buffer, WASAPI buffer size); these are shown in the UI only.
export const LATENCY_PROFILES = {
  ultra: { targetMs: 20, minTargetMs: 15, deviceTargetMs: 10 },
  interactive: { targetMs: 40, minTargetMs: 25, deviceTargetMs: 20 },
  balanced: { targetMs: 60, minTargetMs: 40, deviceTargetMs: 30 },
  playback: { targetMs: 100, minTargetMs: 70, deviceTargetMs: 60 }
};

const state = {
  config: null,
  deviceStates: {},
  devices: { inputs: [], outputs: [] },
  apps: [],
  appsSupported: false,
  selectedStrip: 0,
  stripStatus: [],
  mutedAllSnapshot: null,
  // DUMP: the user's dump device + what the main process reported back.
  dump: { supported: false, devices: [], options: [], loaded: false, target: null, dumped: new Set(), errors: new Map(), lastRequest: "" }
};

let engine = null;
let sources = null;
let inputStrips = [];
let busStrips = {};
let settingsUi = null;
let presetsUi = null;
let appPollTimer = null;
const meters = { inputs: [], buses: {} };
let graphQueue = Promise.resolve();

const inputCount = () => state.config.inputs.length;
const getInput = i => state.config.inputs[i];
const status = (i, s, message) => { state.stripStatus[i] = { state: s, message }; };

// Serialize graph mutations so rapid UI changes never interleave async setup.
function queue(task) {
  graphQueue = graphQueue.then(task).catch(error => reportError("Audio engine", error, "Audio engine error"));
  return graphQueue;
}

// ---------------------------------------------------------------- persistence
const persist = debounce(() => {
  api.config.save(state.config);
  const el = $("#saveState");
  el.textContent = "Saved";
  el.dataset.state = "saved";
}, 250);

function save() {
  const el = $("#saveState");
  el.textContent = "Saving…";
  el.dataset.state = "saving";
  persist();
}

const persistDeviceStates = debounce(() => api.deviceStates.save(state.deviceStates), 400);

// Per-source memory of strip settings. Apps are keyed by exe name (PIDs change).
function stateKey(cfg) {
  if (!cfg.deviceId) return "";
  return isAppSource(cfg.deviceId) ? `app-exe:${(cfg.label || "").toLowerCase()}` : cfg.deviceId;
}

function rememberStripState(i) {
  const cfg = getInput(i);
  const key = stateKey(cfg);
  if (!key) return;
  const { deviceId, label, ...rest } = cfg;
  state.deviceStates[key] = JSON.parse(JSON.stringify({ ...rest, deviceId: key, label }));
  persistDeviceStates();
}

// ---------------------------------------------------------------- lookups
const allInputSources = () => [...state.devices.inputs, ...state.apps];
const findInputSource = id => allInputSources().find(d => d.deviceId === id);
const findOutput = id => state.devices.outputs.find(d => d.deviceId === id);

function busActive() {
  return Object.fromEntries(BUS_IDS.map(id => {
    const bus = state.config.buses[id];
    return [id, !!bus.deviceId && !!findOutput(bus.deviceId)];
  }));
}

// ---------------------------------------------------------------- engine
async function startEngine() {
  engine = new MixerEngine({ latencyHint: state.config.latencyHint, inputCount: inputCount() });
  await engine.init();
  sources = new SourceManager({
    onEnded: (sourceId, reason) => handleSourceEnded(sourceId, reason),
    onAppStats: (sourceId, stats) => handleAppStats(sourceId, stats)
  });
  applyMasterProcessing();
  for (let i = 0; i < inputCount(); i++) await connectInput(i);
  await applyBuses();
}

async function restartEngine() {
  await queue(async () => {
    sources?.dispose();
    await engine?.close();
    await startEngine();
  });
  renderAll();
}

function applyMasterProcessing() {
  if (!engine?.ctx) return;
  const c = state.config;
  engine.setMasterProcessing({ eq: c.eq, driveDb: c.driveDb, softClip: c.softClip, limiter: c.limiter });
}

function applyStripParams() {
  if (!engine?.ctx) return;
  engine.soloActive = state.config.inputs.some(cfg => cfg.solo && cfg.enabled);
  const active = busActive();
  state.config.inputs.forEach((cfg, i) => engine.setStripParams(i, cfg, active));
}

async function applyBuses() {
  if (!engine?.ctx) return;
  const active = busActive();
  BUS_IDS.forEach(id => {
    const bus = state.config.buses[id];
    engine.setBusParams(id, { volumeDb: bus.volumeDb, mute: bus.mute, active: active[id] });
  });
  const errors = await engine.setOutputs(Object.fromEntries(BUS_IDS.map(id => [id, active[id] ? state.config.buses[id].deviceId : ""])));
  Object.entries(errors).forEach(([id, error]) => {
    reportError("Output", error, `Could not use ${state.config.buses[id].label || "the selected device"} for ${BUS_LABELS[id].name}`);
  });
  applyStripParams();
}

async function connectInput(i) {
  const cfg = getInput(i);
  engine.setStripSource(i, null);
  sources.releaseAllExcept(state.config.inputs.filter(c => c.enabled && findInputSource(c.deviceId)).map(c => c.deviceId));
  if (!cfg.deviceId) { status(i, "idle", "No source selected"); return; }
  if (!cfg.enabled) { status(i, "off", "Input disabled"); return; }
  if (!findInputSource(cfg.deviceId)) {
    status(i, "waiting", `${cfg.label || "Source"} is not available. Waiting for it to come back…`);
    return;
  }
  try {
    await sources.open(cfg.deviceId);
    engine.setStripSource(i, cfg.deviceId);
    status(i, "live", `${cfg.label}: live`);
  } catch (error) {
    status(i, "error", `${cfg.label || "Source"}: ${error.message || error}`);
    reportError("Input", error, `Could not open ${cfg.label || `input ${i + 1}`}`);
  }
  applyStripParams();
}

function handleAppStats(sourceId, stats) {
  state.config.inputs.forEach((cfg, i) => {
    if (cfg.deviceId !== sourceId || state.stripStatus[i]?.state !== "live") return;
    const prev = state.stripStatus[i].underruns || 0;
    state.stripStatus[i] = {
      state: "live",
      underruns: stats.underruns,
      message: `${cfg.label}: live · buffer ${stats.fillMs}/${stats.targetMs} ms · ${stats.underruns} dropout(s) · ${stats.gaps || 0} quiet gap(s) · drift ${((stats.rate - 1) * 100).toFixed(2)} %`
    };
    inputStrips[i]?.setStatusTitle(state.stripStatus[i].message);
    if (stats.underruns > prev && stats.underruns % 5 === 0) {
      toast(`${cfg.label}: audio dropouts detected. The buffer grew automatically; consider Settings → Latency / Stability → Stable.`, "info", 6000);
    }
  });
}

function handleSourceEnded(sourceId, reason) {
  state.config.inputs.forEach((cfg, i) => {
    if (cfg.deviceId === sourceId) status(i, "waiting", `${cfg.label || "Source"} stopped (${reason}). Reconnecting…`);
  });
  renderAll();
  scheduleRefresh();
}

// ---------------------------------------------------------------- devices
const scheduleRefresh = debounce(() => refreshDevices({ notify: true }), 800);

async function refreshDevices({ notify = false } = {}) {
  try {
    const [devices, appInfo] = await Promise.all([
      enumerateDevices({ showMultichannel: state.config.showMultichannelDevices }),
      listApps(api.appAudio)
    ]);
    state.devices = devices;
    state.apps = appInfo.apps;
    state.appsSupported = appInfo.supported;
    await refreshDumpDevices();
    await queue(() => reconcile({ notify }));
    renderAll();
    setStatus(`${devices.inputs.length} inputs · ${devices.outputs.length} outputs · ${state.apps.length} apps`);
  } catch (error) {
    reportError("Devices", error, "Could not list audio devices");
  }
  updateAppPolling();
}

// Re-bind missing sources by label (hot-plug, app restarts) and (re)connect strips.
async function reconcile({ notify }) {
  const used = new Set();
  const candidatesFor = cfg => (isAppSource(cfg.deviceId) ? state.apps : state.devices.inputs);
  for (let i = 0; i < inputCount(); i++) {
    const cfg = getInput(i);
    const wasLive = cfg.deviceId && sources.isLive(cfg.deviceId);
    if (cfg.deviceId && !findInputSource(cfg.deviceId)) {
      const replacement = findReplacement(cfg.label, candidatesFor(cfg), used);
      if (replacement) {
        cfg.deviceId = replacement;
        cfg.label = findInputSource(replacement)?.label || cfg.label;
        if (notify) toast(`Input ${i + 1}: reconnected to ${cfg.label}.`, "success");
      } else if (wasLive && notify) {
        toast(`Input ${i + 1}: ${cfg.label || "source"} disconnected. It will reconnect automatically.`, "error");
      }
    }
    if (cfg.deviceId) used.add(cfg.deviceId);
    const available = !cfg.deviceId || !!findInputSource(cfg.deviceId);
    if (!available || !wasLive || !sources.isLive(cfg.deviceId)) await connectInput(i);
  }
  for (const id of BUS_IDS) {
    const bus = state.config.buses[id];
    if (bus.deviceId && !findOutput(bus.deviceId)) {
      const replacement = findReplacement(bus.label, state.devices.outputs);
      if (replacement) {
        bus.deviceId = replacement;
        bus.label = findOutput(replacement)?.label || bus.label;
        if (notify) toast(`${BUS_LABELS[id].name}: reconnected to ${bus.label}.`, "success");
      } else if (notify) {
        toast(`${BUS_LABELS[id].name}: ${bus.label || "device"} disconnected.`, "error");
      }
    }
  }
  await applyBuses();
  save();
}

function updateAppPolling() {
  const needsPoll = state.appsSupported && state.config.inputs.some(cfg => isAppSource(cfg.deviceId) && cfg.enabled);
  if (needsPoll && !appPollTimer) {
    appPollTimer = setInterval(async () => {
      const info = await listApps(api.appAudio);
      const before = new Set(state.apps.map(a => a.deviceId));
      const after = new Set(info.apps.map(a => a.deviceId));
      const changed = before.size !== after.size || [...after].some(id => !before.has(id));
      if (!changed) return;
      state.apps = info.apps;
      await queue(() => reconcile({ notify: true }));
      renderAll();
    }, APP_POLL_MS);
  } else if (!needsPoll && appPollTimer) {
    clearInterval(appPollTimer);
    appPollTimer = null;
  }
}

// ---------------------------------------------------------------- DUMP
async function refreshDumpDevices() {
  const d = state.dump;
  try {
    d.supported = !!(await api.dump?.isSupported());
    d.devices = d.supported ? await api.dump.listDevices() : [];
    d.loaded = true;
  } catch (error) {
    console.warn("Device list for DUMP failed", error);
    d.devices = [];
  }
  updateDumpTarget();
}

function dumpContext() {
  const c = state.config;
  return {
    busLabels: Object.fromEntries(BUS_IDS.map(id => [id, c.buses[id].deviceId ? c.buses[id].label : ""])),
    inputLabels: c.inputs.filter(cfg => cfg.deviceId && !isAppSource(cfg.deviceId)).map(cfg => cfg.label)
  };
}

function updateDumpTarget() {
  const d = state.dump;
  const context = dumpContext();
  d.target = resolveDumpDevice({ devices: d.devices, chosen: state.config.dumpDevice, ...context });
  d.options = dumpDeviceOptions(d.devices, context);
  settingsUi?.renderDump();
}

function dumpStateFor(i) {
  const cfg = getInput(i);
  const d = state.dump;
  const app = isAppSource(cfg.deviceId) ? state.apps.find(a => a.deviceId === cfg.deviceId) : null;
  const key = app?.exeName?.toLowerCase() || "";
  const target = d.target;
  return {
    isApp: isAppSource(cfg.deviceId),
    supported: d.supported,
    active: !!key && d.dumped.has(key),
    error: (key && d.errors.get(key)) || (cfg.dump && target && !target.id ? target.message : "") || "",
    targetName: target?.name || ""
  };
}

const syncDump = debounce(async () => {
  const d = state.dump;
  if (!d.supported || !state.config) return;
  updateDumpTarget();
  const request = buildDumpRequest({ inputs: state.config.inputs, apps: state.apps, targetId: d.target?.id || "" });
  const key = JSON.stringify(request);
  if (key === d.lastRequest) return;
  d.lastRequest = key;
  try {
    const result = await api.dump.sync(request);
    d.dumped = new Set(result?.dumped || []);
    const errors = new Map((result?.errors || []).map(e => [String(e.exeName || "").toLowerCase(), e.message]));
    errors.forEach((message, exe) => {
      if (d.errors.get(exe) !== message) toast(`DUMP${exe ? ` (${exe})` : ""}: ${message}`, "error", 6000);
    });
    d.errors = errors;
    if (errors.size) d.lastRequest = ""; // try again on the next change or poll
  } catch (error) {
    d.lastRequest = "";
    reportError("DUMP", error, "Could not change the app's Windows output");
  }
  renderStripsOnly();
}, 250);

function renderStripsOnly() {
  inputStrips.forEach((strip, i) => strip.updateDump(dumpStateFor(i)));
}

// ---------------------------------------------------------------- controller
const ctl = {
  state,
  get inputCount() { return inputCount(); },
  getInput,
  save,
  applyMasterProcessing,
  renderAll: () => renderAll(),
  restartEngine,
  refreshDevices,

  async setInputSource(i, deviceId) {
    rememberStripState(i);
    const cfg = getInput(i);
    const source = findInputSource(deviceId);
    cfg.deviceId = deviceId;
    cfg.label = source ? source.label : "";
    // Exact key first; Electron-era entries are keyed by Chromium ids, so fall back to the label.
    const remembered = state.deviceStates[stateKey(cfg)] || (!isAppSource(deviceId) && cfg.label
      ? Object.values(state.deviceStates).find(s => !String(s.deviceId).startsWith("app-exe:") && normalizeLabel(s.label) === normalizeLabel(cfg.label))
      : null);
    if (remembered) {
      const { gainDb, mute, solo, forceMono, sends, dump } = remembered;
      Object.assign(cfg, { gainDb, mute, solo, forceMono, dump: !!dump, sends: JSON.parse(JSON.stringify(sends)) });
    }
    await queue(() => connectInput(i));
    save();
    renderAll();
    updateAppPolling();
  },

  updateInput(i, patch) {
    const cfg = getInput(i);
    if (!cfg) return;
    const reconnect = "enabled" in patch && patch.enabled !== cfg.enabled;
    Object.assign(cfg, patch);
    if (reconnect) queue(() => connectInput(i)).then(() => renderAll());
    applyStripParams();
    rememberStripState(i);
    save();
    if (!("gainDb" in patch) || Object.keys(patch).length > 1) renderAll();
    else inputStrips[i].fader.set(cfg.gainDb);
  },

  toggleDump(i) {
    const cfg = getInput(i);
    if (!cfg || !isAppSource(cfg.deviceId)) return;
    const d = state.dump;
    const next = !cfg.dump;
    if (next && !d.supported) {
      toast("DUMP is not available on this system.", "error");
      renderAll();
      return;
    }
    if (next) updateDumpTarget();
    if (next && d.target?.state === "unset") {
      // Nothing to send the app to: leave DUMP off and point at the setting.
      toast("Choose a dump device in Settings first. DUMP sends the app's Windows output there.", "error", 7000);
      ctl.openDumpSettings();
      renderAll();
      return;
    }
    ctl.updateInput(i, { dump: next });
    if (!next) toast(`${cfg.label}: back on its normal Windows output.`, "info");
    else if (!d.target?.id) toast(`${cfg.label}: DUMP is on but not active. ${d.target?.message || ""}`, "error", 7000);
    else if (d.target.state === "warn") toast(`${cfg.label}: dumped to ${d.target.name}. Warning: ${d.target.conflicts.map(c => c.text).join("; ")}.`, "info", 8000);
    else toast(`${cfg.label}: dumped. It now plays to ${d.target.name}, and you hear it through the mixer.`, "success", 5000);
  },

  setDumpDevice(id) {
    const device = state.dump.devices.find(dev => dev.id === id);
    if (id && !device) return; // stale option
    state.config.dumpDevice = { id: device ? device.id : "", name: device ? device.name : "" };
    save();
    updateDumpTarget();
    const t = state.dump.target;
    if (t?.state === "warn") toast(`Dump device set to ${t.name}. Warning: ${t.conflicts.map(c => c.text).join("; ")}.`, "info", 8000);
    renderAll();
  },

  refreshDumpDevices: async () => { await refreshDumpDevices(); renderAll(); },

  updateSend(i, busId, patch) {
    Object.assign(getInput(i).sends[busId], patch);
    applyStripParams();
    rememberStripState(i);
    save();
  },

  async setBusDevice(busId, deviceId) {
    const bus = state.config.buses[busId];
    bus.deviceId = deviceId;
    bus.label = findOutput(deviceId)?.label || "";
    await queue(applyBuses);
    save();
    renderAll();
  },

  updateBus(busId, patch) {
    Object.assign(state.config.buses[busId], patch);
    const bus = state.config.buses[busId];
    engine?.setBusParams(busId, { volumeDb: bus.volumeDb, mute: bus.mute, active: busActive()[busId] });
    save();
    if ("mute" in patch) renderAll();
  },

  toggleMuteAll() {
    const buses = state.config.buses;
    const anyUnmuted = BUS_IDS.some(id => !buses[id].mute && buses[id].deviceId);
    if (anyUnmuted) {
      state.mutedAllSnapshot = Object.fromEntries(BUS_IDS.map(id => [id, buses[id].mute]));
      BUS_IDS.forEach(id => ctl.updateBus(id, { mute: true }));
      toast("All outputs muted (Shift+M to restore).", "info");
    } else {
      const snap = state.mutedAllSnapshot;
      BUS_IDS.forEach(id => ctl.updateBus(id, { mute: snap ? snap[id] : false }));
      state.mutedAllSnapshot = null;
      toast("Outputs restored.", "success");
    }
  },

  clearClip(key) {
    const [kind, id] = key.split(":");
    (kind === "input" ? meters.inputs[Number(id)] : meters.buses[id])?.clearClip();
  },

  selectStrip(i, focus = false) {
    if (i < 0 || i >= inputCount()) return;
    if (state.selectedStrip !== i) {
      state.selectedStrip = i;
      inputStrips.forEach((strip, j) => strip.el.classList.toggle("selected", j === i));
    }
    if (focus) inputStrips[i].fader.input.focus();
  },

  nudgeSelected(delta) { inputStrips[state.selectedStrip]?.fader.nudge(delta); },

  getSnapshot() {
    const c = state.config;
    return JSON.parse(JSON.stringify({ inputs: c.inputs, buses: c.buses, eq: c.eq, driveDb: c.driveDb }));
  },

  async applySnapshot(snapshot) {
    const c = state.config;
    const snap = JSON.parse(JSON.stringify(snapshot));
    c.inputs = snap.inputs;
    c.buses = snap.buses;
    c.eq = snap.eq;
    c.driveDb = snap.driveDb;
    applyMasterProcessing();
    settingsUi.render();
    await queue(() => reconcile({ notify: false }));
    renderAll();
    updateAppPolling();
  },

  savePreset: () => presetsUi.save(),
  loadPresetIndex: i => presetsUi.loadIndex(i),
  applyLayout,
  openSettings: () => togglePanel("#settingsPanel", true),
  openDumpSettings() {
    togglePanel("#settingsPanel", true);
    const section = $("#dumpSection");
    section?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    section?.classList.add("attention");
    setTimeout(() => section?.classList.remove("attention"), 1600);
    $("#dumpDevice")?.focus();
  },
  openHelp: () => $("#helpDialog").showModal(),
  closePanels: () => togglePanel("#settingsPanel", false)
};

// ---------------------------------------------------------------- rendering
function renderAll() {
  if (!state.config) return;
  const c = state.config;
  const inputsById = new Map(allInputSources().map(d => [d.deviceId, d]));
  const outputsById = new Map(state.devices.outputs.map(d => [d.deviceId, d]));
  const disabled = computeDisabledOptions({
    inputIds: c.inputs.map(cfg => cfg.deviceId),
    busDeviceIds: Object.fromEntries(BUS_IDS.map(id => [id, c.buses[id].deviceId])),
    inputsById,
    outputsById,
    enabled: c.enforceRoutingSafety
  });
  inputStrips.forEach((strip, i) => strip.update({
    devices: state.devices.inputs,
    apps: state.apps,
    appsSupported: state.appsSupported,
    disabled: disabled.inputs[i],
    status: state.stripStatus[i] || { state: "idle", message: "" },
    label: c.inputs[i].label,
    selected: state.selectedStrip === i
  }));
  BUS_IDS.forEach(id => busStrips[id].update({ outputs: state.devices.outputs, disabled: disabled.buses[id], bus: c.buses[id] }));
  renderStripsOnly();
  syncDump();
  const solo = c.inputs.some(cfg => cfg.solo && cfg.enabled);
  $("#soloIndicator").hidden = !solo;
}

function renderMeters(now, elapsed) {
  if (!engine?.ctx) return;
  // Stale levels (engine paused, window was hidden) decay to silence.
  const fresh = now - engine.levelsAt < 250;
  state.config.inputs.forEach((_, i) => {
    const [peak, rms] = fresh && engine.hasSource(i) ? engine.levels.inputs[i] : [-Infinity, -Infinity];
    meters.inputs[i].updateLevels(peak, rms, now, elapsed);
    inputStrips[i].renderMeter(meters.inputs[i]);
  });
  BUS_IDS.forEach(id => {
    const [peak, rms, gr] = fresh ? engine.levels.buses[id] : [-Infinity, -Infinity, 0];
    meters.buses[id].updateLevels(peak, rms, now, elapsed);
    busStrips[id].renderMeter(meters.buses[id], gr);
  });
}

function applyLayout() {
  document.body.classList.toggle("compact", !!state.config.compactMode);
}

function togglePanel(selector, open) {
  const panel = $(selector);
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  $("#settingsButton").setAttribute("aria-expanded", String(next));
}

function buildUi() {
  const strips = $("#inputStrips");
  inputStrips = state.config.inputs.map((_, i) => createInputStrip(i, ctl));
  strips.replaceChildren(...inputStrips.map(s => s.el));
  meters.inputs = inputStrips.map(() => new MeterChannel());

  const busContainer = $("#busStrips");
  busStrips = Object.fromEntries(BUS_IDS.map(id => [id, createBusStrip(id, ctl)]));
  busContainer.replaceChildren(...BUS_IDS.map(id => busStrips[id].el));
  BUS_IDS.forEach(id => { meters.buses[id] = new MeterChannel(); });

  settingsUi = initSettings(ctl);
  presetsUi = initPresets(ctl);
  initShortcuts(ctl);

  $("#settingsButton").addEventListener("click", () => togglePanel("#settingsPanel"));
  $("#settingsClose").addEventListener("click", () => togglePanel("#settingsPanel", false));
  $("#refreshButton").addEventListener("click", () => refreshDevices({ notify: true }));
  $("#helpButton").addEventListener("click", () => ctl.openHelp());
  $("#muteAllButton").addEventListener("click", () => ctl.toggleMuteAll());
  $("#shortcutList").replaceChildren(...SHORTCUTS.map(([keys, text]) => h("div", { class: "shortcut" }, h("kbd", {}, keys), h("span", {}, text))));
  applyLayout();

  // Mark the mixer as "wrapped" when outputs drop below inputs so strips halve their
  // height and the divider moves to the top. Re-evaluated on every resize/zoom change.
  const mixer = $("#mixer");
  const outputs = $(".group-outputs");
  const inputs = $(".group-inputs");
  const updateWrap = () => {
    mixer.classList.remove("wrapped");
    const wrapped = outputs.offsetTop > inputs.offsetTop + 4;
    mixer.classList.toggle("wrapped", wrapped);
  };
  new ResizeObserver(updateWrap).observe(mixer);
  updateWrap();
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    const [config, deviceStates, info] = await Promise.all([api.config.load(), api.deviceStates.load(), api.app.info()]);
    state.config = config;
    state.deviceStates = deviceStates || {};
    $("#appVersion").textContent = `v${info.version}`;
    buildUi();
    setStatus("Starting audio engine…");

    await queue(startEngine);
    await refreshDevices({ notify: false });
    new MeterLoop(renderMeters).start();

    api.devices.onChanged(debounce(() => {
      setStatus("Audio devices changed…");
      refreshDevices({ notify: true });
    }, 400));
    api.devices.onOutputError(({ bus, message } = {}) => {
      const name = BUS_LABELS[bus]?.name || "Output";
      reportError("Output", new Error(message || "stopped"), `${name}: the output device stopped`);
      scheduleRefresh();
    });
    if (api.appAudio.onRerouted) api.appAudio.onRerouted(() => {});
    api.app.onCommand(command => { if (command === "toggleMuteAll") ctl.toggleMuteAll(); });
    document.addEventListener("visibilitychange", () => engine?.setMeters(!document.hidden));
    window.addEventListener("beforeunload", () => sources?.dispose());
    setStatus("Ready");
  } catch (error) {
    reportError("Startup", error, "Audio Mixer failed to start");
  }
}

boot();
