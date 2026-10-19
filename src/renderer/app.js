// Renderer entry: owns state and wires the engine, sources, devices and UI together.
import { MixerEngine, BUS_IDS } from "./engine/engine.js";
import { SourceManager, isAppSource } from "./engine/sources.js";
import { MeterChannel, MeterLoop } from "./engine/meters.js";
import { enumerateDevices, listApps, findReplacement, computeDisabledOptions } from "./devices.js";
import { createInputStrip, createBusStrip, BUS_LABELS } from "./ui/mixer.js";
import { initSettings } from "./ui/settings.js";
import { initPresets } from "./ui/presets.js";
import { initShortcuts, SHORTCUTS } from "./ui/shortcuts.js";
import { toast, setStatus, reportError } from "./ui/toast.js";
import { $, h, debounce } from "./ui/dom.js";

const api = window.mixerAPI;
const APP_POLL_MS = 5000;

// "Latency / Stability" profiles: Web Audio latency hint + app-capture jitter buffer.
export const LATENCY_PROFILES = {
  interactive: { targetMs: 40, minTargetMs: 25 },
  balanced: { targetMs: 60, minTargetMs: 40 },
  playback: { targetMs: 100, minTargetMs: 70 }
};

const state = {
  config: null,
  deviceStates: {},
  devices: { inputs: [], outputs: [] },
  apps: [],
  appsSupported: false,
  selectedStrip: 0,
  stripStatus: [],
  mutedAllSnapshot: null
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
    ctxProvider: () => engine.ctx,
    appAudio: api.appAudio,
    onEnded: (sourceId, reason) => handleSourceEnded(sourceId, reason),
    onAppStats: (sourceId, stats) => handleAppStats(sourceId, stats),
    getBufferSettings: () => LATENCY_PROFILES[state.config.latencyHint] || LATENCY_PROFILES.balanced
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
  engine.setStripStream(i, null);
  sources.releaseAllExcept(state.config.inputs.filter(c => c.enabled && findInputSource(c.deviceId)).map(c => c.deviceId));
  if (!cfg.deviceId) { status(i, "idle", "No source selected"); return; }
  if (!cfg.enabled) { status(i, "off", "Input disabled"); return; }
  if (!findInputSource(cfg.deviceId)) {
    status(i, "waiting", `${cfg.label || "Source"} is not available. Waiting for it to come back…`);
    return;
  }
  try {
    const opened = await sources.open(cfg.deviceId);
    if (opened.kind === "node") engine.setStripNode(i, opened.node);
    else engine.setStripStream(i, opened.stream);
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
      message: `${cfg.label}: live · buffer ${stats.fillMs}/${stats.targetMs} ms · ${stats.underruns} dropout(s) · drift ${((stats.rate - 1) * 100).toFixed(2)} %`
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
    const remembered = state.deviceStates[stateKey(cfg)];
    if (remembered) {
      const { gainDb, mute, solo, forceMono, sends } = remembered;
      Object.assign(cfg, { gainDb, mute, solo, forceMono, sends: JSON.parse(JSON.stringify(sends)) });
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
  const solo = c.inputs.some(cfg => cfg.solo && cfg.enabled);
  $("#soloIndicator").hidden = !solo;
}

function renderMeters(now, elapsed) {
  if (!engine?.ctx) return;
  engine.strips.forEach((strip, i) => {
    const live = strip.source !== null;
    strip.meter.analyser.getFloatTimeDomainData(strip.meter.buffer);
    meters.inputs[i].update(live ? strip.meter.buffer : null, now, elapsed);
    inputStrips[i].renderMeter(meters.inputs[i]);
  });
  BUS_IDS.forEach(id => {
    const bus = engine.buses[id];
    bus.meter.analyser.getFloatTimeDomainData(bus.meter.buffer);
    meters.buses[id].update(bus.meter.buffer, now, elapsed);
    busStrips[id].renderMeter(meters.buses[id], bus.gainReductionDb);
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

    // Device labels are only exposed after a capture permission grant.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(t => t.stop());
    } catch (_) {}

    await queue(startEngine);
    await refreshDevices({ notify: false });
    new MeterLoop(renderMeters).start();

    navigator.mediaDevices.addEventListener("devicechange", debounce(() => {
      setStatus("Audio devices changed…");
      refreshDevices({ notify: true });
    }, 400));
    api.app.onCommand(command => { if (command === "toggleMuteAll") ctl.toggleMuteAll(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) engine?.resume(); });
    window.addEventListener("beforeunload", () => sources?.dispose());
    setStatus("Ready");
  } catch (error) {
    reportError("Startup", error, "Audio Mixer failed to start");
  }
}

boot();
