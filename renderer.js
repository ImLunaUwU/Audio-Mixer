const CONFIG_VERSION = 3;
const METER_FLOOR_DB = -41;

let config = {
  version: CONFIG_VERSION,
  inputs: [],
  compactMode: false,
  showMultichannelDevices: false,
  enforceRoutingSafety: true,
  monitorDeviceId: null,
  monitor2DeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  monitor2MasterVolume: 1,
  outputMasterVolume: 1,
  eq: { low: 0, mid: 0, high: 0 },
  eqCustomPresets: [],
  overloadGain: 1,
  presets: []
};

const BUILTIN_EQ_PRESETS = {
  flat: { low: 0, mid: 0, high: 0 },
  voice: { low: -2.0, mid: 3.5, high: 1.5 },
  broadcast: { low: 2.5, mid: 2.0, high: -1.0 },
  bright: { low: -1.5, mid: 1.0, high: 3.5 },
  bassheavy: { low: 5.0, mid: -2.0, high: -1.0 }
};

let deviceStates = {};
let activeStreams = {};
let audioCtx = null;
let monoStressRunning = false;
let meterTimer = null;
let watchdogTimer = null;
let graphBuildQueue = Promise.resolve();
let saveTimer = null;
let saveIndicatorTimer = null;

const observedTracks = new WeakSet();
const recoveryDebounceMap = {};
const historicalDeviceLabels = {};
const inputChannelCountCache = {};
const outputChannelCountCache = {};
let cachedInputDevices = [];
let cachedOutputDevices = [];

const ui = {
  inputSels: [],
  monitorSel: null,
  monitor2Sel: null,
  mixedSel: null,
  sources: null,
  monitorMasterSlider: null,
  monitor2MasterSlider: null,
  outputMasterSlider: null,
  eqLowSlider: null,
  eqMidSlider: null,
  eqHighSlider: null,
  eqPresetSelect: null,
  eqPresetName: null,
  eqPresetSave: null,
  eqPresetDelete: null,
  overloadSlider: null,
  eqLowDisplay: null,
  eqMidDisplay: null,
  eqHighDisplay: null,
  overloadDisplay: null,
  presetSelect: null,
  presetName: null,
  presetSave: null,
  presetLoad: null,
  presetDelete: null,
  monitorMasterDisplay: null,
  monitor2MasterDisplay: null,
  outputMasterDisplay: null,
  monitorMeterFill: null,
  monitor2MeterFill: null,
  outputMeterFill: null,
  monitorMeterText: null,
  monitor2MeterText: null,
  outputMeterText: null,
  monitorClip: null,
  monitor2Clip: null,
  outputClip: null,
  statusText: null,
  saveStateText: null,
  compactModeToggle: null,
  startOnBootToggle: null,
  showMultichannelDevicesToggle: null,
  enforceRoutingSafetyToggle: null,
  toastContainer: null,
  refreshAppSources: null
};

let sourceCardRefs = [null, null, null];

const gainMap = {
  monitorMaster: null,
  monitor2Master: null,
  outputMaster: null,
  eqLowMonitor: null,
  eqMidMonitor: null,
  eqHighMonitor: null,
  eqLowMonitor2: null,
  eqMidMonitor2: null,
  eqHighMonitor2: null,
  eqLowOutput: null,
  eqMidOutput: null,
  eqHighOutput: null,
  overloadMonitor: null,
  overloadMonitor2: null,
  overloadOutput: null,
  limiterMonitor: null,
  limiterMonitor2: null,
  limiterOutput: null,
  perInput: []
};

const audioGraph = {
  monitorOut: null,
  monitor2Out: null,
  mixedOut: null,
  eqInputMonitor: null,
  eqInputMonitor2: null,
  eqInputOutput: null,
  monitorAudio: null,
  monitor2Audio: null,
  mixedAudio: null,
  monitorOutputCtx: null,
  monitor2OutputCtx: null,
  mixedOutputCtx: null,
  monitorOutputSource: null,
  monitor2OutputSource: null,
  mixedOutputSource: null,
  monitorOutputGain: null,
  monitor2OutputGain: null,
  mixedOutputGain: null,
  monitorMeterAnalyser: null,
  monitor2MeterAnalyser: null,
  outputMeterAnalyser: null,
  monitorMeterBuffer: null,
  monitor2MeterBuffer: null,
  outputMeterBuffer: null,
  inputRoutes: [null, null, null]
};

const clipHoldUntil = {
  monitor: 0,
  monitor2: 0,
  output: 0,
  inputs: [0, 0, 0]
};

function debounce(fn, delayMs) {
  let timeout = null;
  return (...args) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delayMs);
  };
}

function getDefaultInputConfig(deviceId = "") {
  return {
    deviceId,
    enabled: true,
    monitorVolume: 1,
    monitor2Volume: 1,
    outputVolume: 1,
    monitorMute: false,
    monitor2Mute: false,
    outputMute: false,
    forceMono: false
  };
}

function getInputConfig(index) {
  if (!config.inputs[index] || typeof config.inputs[index] !== "object") {
    config.inputs[index] = getDefaultInputConfig();
  }

  const input = config.inputs[index];
  const monitorVolume = Number.isFinite(input.monitorVolume) ? input.monitorVolume : 1;
  input.deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
  input.enabled = input.enabled !== false;
  input.monitorVolume = monitorVolume;
  input.monitor2Volume = Number.isFinite(input.monitor2Volume) ? input.monitor2Volume : monitorVolume;
  input.outputVolume = Number.isFinite(input.outputVolume) ? input.outputVolume : 1;
  input.monitorMute = !!input.monitorMute;
  input.monitor2Mute = typeof input.monitor2Mute === "boolean" ? input.monitor2Mute : !!input.monitorMute;
  input.outputMute = !!input.outputMute;
  input.forceMono = !!input.forceMono;
  return input;
}

async function getInputDeviceChannelCount(deviceId, { allowProbe = true } = {}) {
  if (!deviceId || isAppSourceId(deviceId)) return 2;
  if (Number.isFinite(inputChannelCountCache[deviceId])) return inputChannelCountCache[deviceId];

  const existingStream = activeStreams[deviceId];
  if (existingStream && hasLiveTrack(existingStream)) {
    const liveTrack = existingStream.getAudioTracks()[0];
    const liveCount = liveTrack?.getSettings?.().channelCount;
    if (Number.isFinite(liveCount) && liveCount > 0) {
      inputChannelCountCache[deviceId] = liveCount;
      return liveCount;
    }
  }

  if (!allowProbe) return 2;

  try {
    const probeStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        channelCount: { ideal: 8 }
      }
    });
    const probeTrack = probeStream.getAudioTracks()[0];
    const channelCount = probeTrack?.getSettings?.().channelCount;
    probeStream.getTracks().forEach(track => track.stop());
    const normalized = Number.isFinite(channelCount) && channelCount > 0 ? channelCount : 2;
    inputChannelCountCache[deviceId] = normalized;
    return normalized;
  } catch (_) {
    inputChannelCountCache[deviceId] = 2;
    return 2;
  }
}

function inferChannelsFromLabel(label = "") {
  const normalized = String(label || "").toLowerCase();
  if (!normalized) return 2;

  const explicitChannelMatch = normalized.match(/\b(\d{1,2})\s*(?:ch|channel|channels)\b/);
  if (explicitChannelMatch) {
    const explicitCount = parseInt(explicitChannelMatch[1], 10);
    if (Number.isFinite(explicitCount) && explicitCount > 0) return explicitCount;
  }

  if (/(^|\b)mono(\b|$)|\b1\s*(ch|channel)\b/.test(normalized)) return 1;
  if (/\b(stereo|2\.0|2ch|2 channel)\b/.test(normalized)) return 2;
  if (/\b(3\.1|4\.0|4\.1|5\.1|6\.1|7\.1|surround|quad|atmos|dolby|dts|4ch|6ch|8ch)\b/.test(normalized)) return 6;
  return 2;
}

function getOutputDeviceChannelCount(device) {
  const deviceId = device?.deviceId;
  if (!deviceId) return 2;
  if (Number.isFinite(outputChannelCountCache[deviceId])) return outputChannelCountCache[deviceId];

  const inferred = inferChannelsFromLabel(device?.label);
  outputChannelCountCache[deviceId] = inferred;
  return inferred;
}

function setStatus(message) {
  if (!ui.statusText) return;
  ui.statusText.textContent = message || "Ready";
}

function markSavedState(isSaving) {
  if (!ui.saveStateText) return;
  if (isSaving) {
    ui.saveStateText.textContent = "Saving...";
    ui.saveStateText.classList.add("saving");
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);
    return;
  }
  ui.saveStateText.textContent = "All changes saved";
  ui.saveStateText.classList.remove("saving");
}

function saveConfig() {
  markSavedState(true);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.configAPI.saveConfig(config);
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => {
      markSavedState(false);
    }, 120);
  }, 140);
}

function showToast(message, variant = "info", timeout = 3200) {
  if (!ui.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast ${variant}`;
  toast.textContent = message;
  ui.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, timeout);
}

function reportError(context, error, userMessage) {
  console.error(`${context}:`, error);
  setStatus(userMessage || `${context} failed`);
  showToast(userMessage || `${context} failed`, "error", 4500);
}

function applyCompactMode(enabled) {
  const compact = !!enabled;
  document.body.classList.toggle("compact-mode", compact);
  if (ui.compactModeToggle) ui.compactModeToggle.checked = compact;
}

function disconnectNode(node) {
  if (!node) return;
  try {
    node.disconnect();
  } catch (_) {}
}

function hasLiveTrack(stream) {
  return !!stream && stream.getAudioTracks().some(track => track.readyState === "live");
}

function rampGain(gainNode, target, smoothing = 0.02) {
  if (!gainNode || !gainNode.gain) return;
  if (!audioCtx) {
    gainNode.gain.value = target;
    return;
  }
  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setTargetAtTime(target, now, smoothing);
}

function saveInputStateByIndex(index) {
  const inputCfg = getInputConfig(index);
  const deviceId = inputCfg.deviceId;
  if (!deviceId) return;
  deviceStates[deviceId] = {
    ...inputCfg,
    label: historicalDeviceLabels[deviceId] || `Input ${index + 1}`
  };
  window.deviceStateAPI.saveState(deviceStates);
}

function teardownRoute(index) {
  const route = audioGraph.inputRoutes[index];
  if (!route) return;

  disconnectNode(route.source);
  disconnectNode(route.monoSplitter);
  disconnectNode(route.monoMerger);
  disconnectNode(route.inputAnalyser);
  disconnectNode(route.monitorGain);
  disconnectNode(route.monitor2Gain);
  disconnectNode(route.outputGain);

  audioGraph.inputRoutes[index] = null;
  gainMap.perInput[index] = null;
}

function queueGraphTask(taskFn) {
  graphBuildQueue = graphBuildQueue
    .then(taskFn)
    .catch(error => {
      reportError("Audio graph update", error, "Audio routing update failed.");
    });
  return graphBuildQueue;
}

function queueBuildAudioGraph() {
  return queueGraphTask(async () => {
    await buildAudioGraph();
  });
}

function queueRebuildInputRoute(index, rerenderCard = true) {
  return queueGraphTask(async () => {
    if (rerenderCard) {
      replaceSourceCard(index);
    }
    await rebuildInputRoute(index);
  });
}

function replaceSourceCard(index) {
  const card = renderSourceCard(index);
  const current = ui.sources.children[index];
  if (current) {
    ui.sources.replaceChild(card, current);
  } else {
    ui.sources.appendChild(card);
  }
}

function initialiseUiRefs() {
  ui.inputSels = [
    document.getElementById("input1"),
    document.getElementById("input2"),
    document.getElementById("input3")
  ];
  ui.monitorSel = document.getElementById("monitorDevice");
  ui.monitor2Sel = document.getElementById("monitor2Device");
  ui.mixedSel = document.getElementById("mixedOutputDevice");
  ui.sources = document.getElementById("sources");
  ui.monitorMasterSlider = document.getElementById("monitorMaster");
  ui.monitor2MasterSlider = document.getElementById("monitor2Master");
  ui.outputMasterSlider = document.getElementById("outputMaster");
  ui.eqLowSlider = document.getElementById("eqLowControl");
  ui.eqMidSlider = document.getElementById("eqMidControl");
  ui.eqHighSlider = document.getElementById("eqHighControl");
  ui.eqPresetSelect = document.getElementById("eqPresetSelect");
  ui.eqPresetName = document.getElementById("eqPresetName");
  ui.eqPresetSave = document.getElementById("eqPresetSave");
  ui.eqPresetDelete = document.getElementById("eqPresetDelete");
  ui.overloadSlider = document.getElementById("overloadControl");
  ui.eqLowDisplay = document.getElementById("eqLowDisplay");
  ui.eqMidDisplay = document.getElementById("eqMidDisplay");
  ui.eqHighDisplay = document.getElementById("eqHighDisplay");
  ui.overloadDisplay = document.getElementById("overloadDisplay");
  ui.presetSelect = document.getElementById("presetSelect");
  ui.presetName = document.getElementById("presetName");
  ui.presetSave = document.getElementById("presetSave");
  ui.refreshAppSources = document.getElementById("refreshAppSources");
  ui.presetLoad = document.getElementById("presetLoad");
  ui.presetDelete = document.getElementById("presetDelete");
  ui.monitorMasterDisplay = document.getElementById("monitorMasterDisplay");
  ui.monitor2MasterDisplay = document.getElementById("monitor2MasterDisplay");
  ui.outputMasterDisplay = document.getElementById("outputMasterDisplay");
  ui.monitorMeterFill = document.getElementById("monitorMeterFill");
  ui.monitor2MeterFill = document.getElementById("monitor2MeterFill");
  ui.outputMeterFill = document.getElementById("outputMeterFill");
  ui.monitorMeterText = document.getElementById("monitorMeterText");
  ui.monitor2MeterText = document.getElementById("monitor2MeterText");
  ui.outputMeterText = document.getElementById("outputMeterText");
  ui.monitorClip = document.getElementById("monitorClip");
  ui.monitor2Clip = document.getElementById("monitor2Clip");
  ui.outputClip = document.getElementById("outputClip");
  ui.statusText = document.getElementById("statusText");
  ui.saveStateText = document.getElementById("saveStateText");
  ui.compactModeToggle = document.getElementById("compactModeToggle");
  ui.startOnBootToggle = document.getElementById("startOnBootToggle");
  ui.showMultichannelDevicesToggle = document.getElementById("showMultichannelDevices");
  ui.enforceRoutingSafetyToggle = document.getElementById("enforceRoutingSafetyToggle");
  ui.toastContainer = document.getElementById("toastContainer");
}

function applyUiFromConfig() {
  ui.monitorMasterSlider.value = config.monitorMasterVolume;
  ui.monitor2MasterSlider.value = config.monitor2MasterVolume;
  ui.outputMasterSlider.value = config.outputMasterVolume;
  ui.eqLowSlider.value = config.eq.low;
  ui.eqMidSlider.value = config.eq.mid;
  ui.eqHighSlider.value = config.eq.high;
  ui.overloadSlider.value = config.overloadGain;
  ui.monitorMasterDisplay.textContent = `${Math.round(config.monitorMasterVolume * 100)}%`;
  ui.monitor2MasterDisplay.textContent = `${Math.round(config.monitor2MasterVolume * 100)}%`;
  ui.outputMasterDisplay.textContent = `${Math.round(config.outputMasterVolume * 100)}%`;
  ui.eqLowDisplay.textContent = `${parseFloat(config.eq.low).toFixed(1)} dB`;
  ui.eqMidDisplay.textContent = `${parseFloat(config.eq.mid).toFixed(1)} dB`;
  ui.eqHighDisplay.textContent = `${parseFloat(config.eq.high).toFixed(1)} dB`;
  ui.overloadDisplay.textContent = `${Math.round(config.overloadGain * 100)}%`;
  applyCompactMode(config.compactMode);
  if (ui.showMultichannelDevicesToggle) {
    ui.showMultichannelDevicesToggle.checked = !!config.showMultichannelDevices;
  }
  if (ui.enforceRoutingSafetyToggle) {
    ui.enforceRoutingSafetyToggle.checked = config.enforceRoutingSafety !== false;
  }
}

function getPresetSnapshot() {
  return {
    inputs: config.inputs.map(input => ({ ...input })),
    monitorDeviceId: config.monitorDeviceId,
    monitor2DeviceId: config.monitor2DeviceId,
    mixedOutputDeviceId: config.mixedOutputDeviceId,
    monitorMasterVolume: config.monitorMasterVolume,
    monitor2MasterVolume: config.monitor2MasterVolume,
    outputMasterVolume: config.outputMasterVolume,
    eq: { ...config.eq },
    overloadGain: config.overloadGain,
  };
}

function upsertPreset(name, snapshot) {
  const normalized = name.trim();
  if (!normalized) return;
  const idx = config.presets.findIndex(p => p.name.toLowerCase() === normalized.toLowerCase());
  const entry = { name: normalized, snapshot };
  if (idx >= 0) config.presets[idx] = entry;
  else config.presets.push(entry);
}

function refreshPresetSelect(selectedName = "") {
  if (!ui.presetSelect) return;
  ui.presetSelect.innerHTML = '<option value="">(None)</option>';
  config.presets.forEach(preset => {
    const opt = document.createElement("option");
    opt.value = preset.name;
    opt.textContent = preset.name;
    ui.presetSelect.appendChild(opt);
  });
  ui.presetSelect.value = selectedName || "";
}

function refreshEqPresetSelect(selectedValue = "flat") {
  if (!ui.eqPresetSelect) return;

  const current = selectedValue || ui.eqPresetSelect.value || "flat";
  while (ui.eqPresetSelect.options.length > 5) {
    ui.eqPresetSelect.remove(5);
  }

  config.eqCustomPresets.forEach(preset => {
    const opt = document.createElement("option");
    opt.value = `custom:${preset.name}`;
    opt.textContent = `${preset.name} (Custom)`;
    ui.eqPresetSelect.appendChild(opt);
  });

  ui.eqPresetSelect.value = current;
}

function findEqCustomPreset(name) {
  return config.eqCustomPresets.find(preset => preset.name === name);
}

function applyEqValues(values) {
  config.eq.low = Number.isFinite(values.low) ? values.low : 0;
  config.eq.mid = Number.isFinite(values.mid) ? values.mid : 0;
  config.eq.high = Number.isFinite(values.high) ? values.high : 0;
  applyUiFromConfig();
  applyMasterAudioParams();
  saveConfig();
}

async function applyPresetByName(name) {
  const preset = config.presets.find(item => item.name === name);
  if (!preset || !preset.snapshot) return;

  const snapshot = preset.snapshot;
  config.inputs = Array.isArray(snapshot.inputs)
    ? snapshot.inputs.map(input => {
      const normalized = { ...getDefaultInputConfig(), ...input };
      const monitorVolume = Number.isFinite(normalized.monitorVolume) ? normalized.monitorVolume : 1;
      return {
        ...normalized,
        monitorVolume,
        monitor2Volume: Number.isFinite(normalized.monitor2Volume) ? normalized.monitor2Volume : monitorVolume,
        monitorMute: !!normalized.monitorMute,
        monitor2Mute: typeof normalized.monitor2Mute === "boolean" ? normalized.monitor2Mute : !!normalized.monitorMute,
        outputMute: !!normalized.outputMute,
        forceMono: !!normalized.forceMono,
        enabled: normalized.enabled !== false
      };
    })
    : [getDefaultInputConfig(), getDefaultInputConfig(), getDefaultInputConfig()];
  config.monitorDeviceId = snapshot.monitorDeviceId || "";
  config.monitor2DeviceId = snapshot.monitor2DeviceId || "";
  config.mixedOutputDeviceId = snapshot.mixedOutputDeviceId || "";
  config.monitorMasterVolume = Number.isFinite(snapshot.monitorMasterVolume) ? snapshot.monitorMasterVolume : 1;
  config.monitor2MasterVolume = Number.isFinite(snapshot.monitor2MasterVolume) ? snapshot.monitor2MasterVolume : config.monitorMasterVolume;
  config.outputMasterVolume = Number.isFinite(snapshot.outputMasterVolume) ? snapshot.outputMasterVolume : 1;
  config.eq = {
    low: Number.isFinite(snapshot?.eq?.low) ? snapshot.eq.low : 0,
    mid: Number.isFinite(snapshot?.eq?.mid) ? snapshot.eq.mid : 0,
    high: Number.isFinite(snapshot?.eq?.high) ? snapshot.eq.high : 0
  };
  config.overloadGain = Number.isFinite(snapshot.overloadGain) ? snapshot.overloadGain : 1;

  applyUiFromConfig();
  for (let i = 0; i < 3; i++) {
    ui.inputSels[i].value = getInputConfig(i).deviceId || "";
  }
  ui.monitorSel.value = config.monitorDeviceId || "";
  ui.monitor2Sel.value = config.monitor2DeviceId || "";
  ui.mixedSel.value = config.mixedOutputDeviceId || "";

  enforceRoutingSelectionRules({ notify: false });
  syncRoutingConfigFromSelectors();

  saveConfig();
  await queueBuildAudioGraph();
  await refreshDeviceLists({ rebindMissing: true, notify: false });
  showToast(`Loaded preset: ${name}`, "success");
}

function applyMasterAudioParams() {
  if (gainMap.monitorMaster) rampGain(gainMap.monitorMaster, config.monitorMasterVolume);
  if (gainMap.monitor2Master) rampGain(gainMap.monitor2Master, config.monitor2MasterVolume);
  if (gainMap.outputMaster) rampGain(gainMap.outputMaster, config.outputMasterVolume);
  if (gainMap.eqLowMonitor) gainMap.eqLowMonitor.gain.value = config.eq.low;
  if (gainMap.eqMidMonitor) gainMap.eqMidMonitor.gain.value = config.eq.mid;
  if (gainMap.eqHighMonitor) gainMap.eqHighMonitor.gain.value = config.eq.high;
  if (gainMap.eqLowMonitor2) gainMap.eqLowMonitor2.gain.value = config.eq.low;
  if (gainMap.eqMidMonitor2) gainMap.eqMidMonitor2.gain.value = config.eq.mid;
  if (gainMap.eqHighMonitor2) gainMap.eqHighMonitor2.gain.value = config.eq.high;
  if (gainMap.eqLowOutput) gainMap.eqLowOutput.gain.value = config.eq.low;
  if (gainMap.eqMidOutput) gainMap.eqMidOutput.gain.value = config.eq.mid;
  if (gainMap.eqHighOutput) gainMap.eqHighOutput.gain.value = config.eq.high;
  if (gainMap.overloadMonitor) rampGain(gainMap.overloadMonitor, config.overloadGain, 0.03);
  if (gainMap.overloadMonitor2) rampGain(gainMap.overloadMonitor2, config.overloadGain, 0.03);
  if (gainMap.overloadOutput) rampGain(gainMap.overloadOutput, config.overloadGain, 0.03);
}

function configureLimiter(compressor) {
  compressor.threshold.value = -1.0;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.05;
}

function bindStreamTrackRecovery(deviceId, stream) {
  stream.getAudioTracks().forEach(track => {
    if (observedTracks.has(track)) return;
    observedTracks.add(track);
    track.addEventListener("ended", () => {
      scheduleInputRecovery(deviceId, "track ended");
    });
  });
}


// ---------------------------------------------------------------------------
// Per-application audio sources (Windows WASAPI process loopback)
// ---------------------------------------------------------------------------
// Application sources use deviceIds of the form "app:<pid>" so they flow through
// the same routing/preset/device-state code as hardware inputs. Raw PCM
// (s16le, 2ch, 48 kHz) arrives from the main process over IPC and is played into
// the shared AudioContext by a small AudioWorklet, exposed as a MediaStream.
const APP_SOURCE_PREFIX = "app:";
const APP_PCM_SAMPLE_RATE = 48000;
const APP_PCM_CHANNELS = 2;
const appSources = {};
let appAudioSupported = false;
let appAudioUnsubscribe = null;
let appWorkletContext = null;
let cachedAppSources = [];

const APP_WORKLET_SOURCE = `
class AppPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.ratio = (opts.inputRate || 48000) / sampleRate;
    this.capacity = Math.ceil((opts.inputRate || 48000) * 0.5);
    this.maxFill = Math.ceil((opts.inputRate || 48000) * (opts.maxLatency || 0.12));
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.fill = 0;
    this.port.onmessage = event => this.push(new Int16Array(event.data));
  }
  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.writePos] = samples[i * 2] / 32768;
      this.right[this.writePos] = samples[i * 2 + 1] / 32768;
      this.writePos = (this.writePos + 1) % this.capacity;
      if (this.fill < this.capacity) this.fill++;
      else this.readPos = (this.readPos + 1) % this.capacity;
    }
    if (this.fill > this.maxFill) {
      const drop = this.fill - Math.floor(this.maxFill / 2);
      this.readPos = (this.readPos + drop) % this.capacity;
      this.fill -= drop;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    for (let i = 0; i < outL.length; i++) {
      if (this.fill < 2) {
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }
      const next = (this.readPos + 1) % this.capacity;
      const frac = this.frac || 0;
      outL[i] = this.left[this.readPos] + (this.left[next] - this.left[this.readPos]) * frac;
      outR[i] = this.right[this.readPos] + (this.right[next] - this.right[this.readPos]) * frac;
      let advance = frac + this.ratio;
      const whole = Math.floor(advance);
      this.frac = advance - whole;
      this.readPos = (this.readPos + whole) % this.capacity;
      this.fill = Math.max(0, this.fill - whole);
    }
    return true;
  }
}
registerProcessor("app-pcm-player", AppPcmPlayer);
`;

function isAppSourceId(deviceId) {
  return typeof deviceId === "string" && deviceId.startsWith(APP_SOURCE_PREFIX);
}

function getAppSourcePid(deviceId) {
  return isAppSourceId(deviceId) ? deviceId.slice(APP_SOURCE_PREFIX.length) : "";
}

function ensureAppAudioListener() {
  if (appAudioUnsubscribe || !window.appAudioAPI) return;
  appAudioUnsubscribe = window.appAudioAPI.onData((pid, chunk) => {
    const entry = appSources[pid];
    if (!entry || !entry.node) return;
    let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (entry.remainder && entry.remainder.length) {
      const merged = new Uint8Array(entry.remainder.length + bytes.length);
      merged.set(entry.remainder, 0);
      merged.set(bytes, entry.remainder.length);
      bytes = merged;
    }
    const frameBytes = APP_PCM_CHANNELS * 2;
    const usable = bytes.length - (bytes.length % frameBytes);
    entry.remainder = usable < bytes.length ? bytes.slice(usable) : null;
    if (!usable) return;
    const aligned = bytes.slice(0, usable).buffer;
    entry.node.port.postMessage(aligned, [aligned]);
  });
}

async function ensureAppWorklet() {
  if (appWorkletContext === audioCtx) return;
  const blobUrl = URL.createObjectURL(new Blob([APP_WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    await audioCtx.audioWorklet.addModule(blobUrl);
    appWorkletContext = audioCtx;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function createAppSourceStream(deviceId) {
  if (!appAudioSupported || !window.appAudioAPI) {
    throw new Error("Per-application capture is not supported on this system.");
  }
  const pid = getAppSourcePid(deviceId);
  if (!pid) throw new Error("Invalid application source.");

  await ensureAudioEngine();
  await ensureAppWorklet();
  ensureAppAudioListener();
  releaseAppSource(deviceId);

  const node = new AudioWorkletNode(audioCtx, "app-pcm-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [APP_PCM_CHANNELS],
    processorOptions: { inputRate: APP_PCM_SAMPLE_RATE, maxLatency: 0.12 }
  });
  const destination = audioCtx.createMediaStreamDestination();
  destination.channelCount = APP_PCM_CHANNELS;
  node.connect(destination);

  appSources[pid] = { node, destination, remainder: null };
  try {
    await window.appAudioAPI.startCapture(pid);
  } catch (error) {
    releaseAppSource(deviceId);
    throw error;
  }
  return destination.stream;
}

function releaseAppSource(deviceId) {
  const pid = getAppSourcePid(deviceId);
  const entry = pid ? appSources[pid] : null;
  if (!entry) return;
  delete appSources[pid];
  try {
    window.appAudioAPI?.stopCapture(pid);
  } catch (_) {}
  disconnectNode(entry.node);
  entry.destination?.stream?.getTracks().forEach(track => track.stop());
  if (activeStreams[deviceId] === entry.destination?.stream) delete activeStreams[deviceId];
}

function releaseUnusedAppSources() {
  const inUse = new Set([0, 1, 2]
    .map(index => getInputConfig(index))
    .filter(cfg => cfg.enabled !== false && isAppSourceId(cfg.deviceId))
    .map(cfg => cfg.deviceId));
  Object.keys(appSources).forEach(pid => {
    const deviceId = `${APP_SOURCE_PREFIX}${pid}`;
    if (!inUse.has(deviceId)) releaseAppSource(deviceId);
  });
}

async function listAppSources() {
  if (!window.appAudioAPI) return [];
  try {
    appAudioSupported = !!(await window.appAudioAPI.isSupported());
    if (!appAudioSupported) return [];
    const apps = await window.appAudioAPI.listApps();
    return (Array.isArray(apps) ? apps : []).map(app => ({
      deviceId: `${APP_SOURCE_PREFIX}${app.pid}`,
      kind: "appaudio",
      label: `App: ${app.exeName || app.title || `PID ${app.pid}`}`,
      title: app.title || ""
    }));
  } catch (error) {
    console.warn("Failed to list application audio sources", error);
    return [];
  }
}

async function getOrCreateStream(deviceId) {
  const existing = activeStreams[deviceId];
  if (hasLiveTrack(existing)) return existing;

  if (isAppSourceId(deviceId)) {
    const appStream = await createAppSourceStream(deviceId);
    activeStreams[deviceId] = appStream;
    return appStream;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      channelCount: 2,
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.005, max: 0.02 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  activeStreams[deviceId] = stream;
  bindStreamTrackRecovery(deviceId, stream);
  return stream;
}

async function ensureAudioEngine() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ latencyHint: "interactive" });
    audioGraph.monitorOut = audioCtx.createMediaStreamDestination();
    audioGraph.monitor2Out = audioCtx.createMediaStreamDestination();
    audioGraph.mixedOut = audioCtx.createMediaStreamDestination();

    gainMap.monitorMaster = audioCtx.createGain();
    gainMap.monitor2Master = audioCtx.createGain();
    gainMap.outputMaster = audioCtx.createGain();
    gainMap.eqLowMonitor = audioCtx.createBiquadFilter();
    gainMap.eqMidMonitor = audioCtx.createBiquadFilter();
    gainMap.eqHighMonitor = audioCtx.createBiquadFilter();
    gainMap.eqLowMonitor2 = audioCtx.createBiquadFilter();
    gainMap.eqMidMonitor2 = audioCtx.createBiquadFilter();
    gainMap.eqHighMonitor2 = audioCtx.createBiquadFilter();
    gainMap.eqLowOutput = audioCtx.createBiquadFilter();
    gainMap.eqMidOutput = audioCtx.createBiquadFilter();
    gainMap.eqHighOutput = audioCtx.createBiquadFilter();
    gainMap.overloadMonitor = audioCtx.createGain();
    gainMap.overloadMonitor2 = audioCtx.createGain();
    gainMap.overloadOutput = audioCtx.createGain();
    gainMap.limiterMonitor = audioCtx.createDynamicsCompressor();
    gainMap.limiterMonitor2 = audioCtx.createDynamicsCompressor();
    gainMap.limiterOutput = audioCtx.createDynamicsCompressor();

    gainMap.eqLowMonitor.type = "lowshelf";
    gainMap.eqLowMonitor.frequency.value = 180;
    gainMap.eqMidMonitor.type = "peaking";
    gainMap.eqMidMonitor.frequency.value = 1400;
    gainMap.eqMidMonitor.Q.value = 0.9;
    gainMap.eqHighMonitor.type = "highshelf";
    gainMap.eqHighMonitor.frequency.value = 5600;

    gainMap.eqLowMonitor2.type = "lowshelf";
    gainMap.eqLowMonitor2.frequency.value = 180;
    gainMap.eqMidMonitor2.type = "peaking";
    gainMap.eqMidMonitor2.frequency.value = 1400;
    gainMap.eqMidMonitor2.Q.value = 0.9;
    gainMap.eqHighMonitor2.type = "highshelf";
    gainMap.eqHighMonitor2.frequency.value = 5600;

    gainMap.eqLowOutput.type = "lowshelf";
    gainMap.eqLowOutput.frequency.value = 180;
    gainMap.eqMidOutput.type = "peaking";
    gainMap.eqMidOutput.frequency.value = 1400;
    gainMap.eqMidOutput.Q.value = 0.9;
    gainMap.eqHighOutput.type = "highshelf";
    gainMap.eqHighOutput.frequency.value = 5600;

    configureLimiter(gainMap.limiterMonitor);
    configureLimiter(gainMap.limiterMonitor2);
    configureLimiter(gainMap.limiterOutput);

    audioGraph.monitorMeterAnalyser = audioCtx.createAnalyser();
    audioGraph.monitor2MeterAnalyser = audioCtx.createAnalyser();
    audioGraph.outputMeterAnalyser = audioCtx.createAnalyser();
    audioGraph.monitorMeterAnalyser.fftSize = 256;
    audioGraph.monitor2MeterAnalyser.fftSize = 256;
    audioGraph.outputMeterAnalyser.fftSize = 256;
    audioGraph.monitorMeterBuffer = new Uint8Array(audioGraph.monitorMeterAnalyser.fftSize);
    audioGraph.monitor2MeterBuffer = new Uint8Array(audioGraph.monitor2MeterAnalyser.fftSize);
    audioGraph.outputMeterBuffer = new Uint8Array(audioGraph.outputMeterAnalyser.fftSize);

    gainMap.monitorMaster.connect(audioGraph.monitorOut);
    gainMap.monitor2Master.connect(audioGraph.monitor2Out);

    gainMap.outputMaster.connect(audioGraph.mixedOut);
    gainMap.monitorMaster.connect(audioGraph.monitorMeterAnalyser);
    gainMap.monitor2Master.connect(audioGraph.monitor2MeterAnalyser);
    gainMap.outputMaster.connect(audioGraph.outputMeterAnalyser);

    audioGraph.eqInputMonitor = gainMap.monitorMaster;
    audioGraph.eqInputMonitor2 = gainMap.monitor2Master;
    audioGraph.eqInputOutput = gainMap.outputMaster;

    audioGraph.monitorAudio = new Audio();
    audioGraph.monitorAudio.srcObject = audioGraph.monitorOut.stream;
    audioGraph.monitorAudio.autoplay = true;

    audioGraph.monitor2Audio = new Audio();
    audioGraph.monitor2Audio.srcObject = audioGraph.monitor2Out.stream;
    audioGraph.monitor2Audio.autoplay = true;

    audioGraph.mixedAudio = new Audio();
    audioGraph.mixedAudio.srcObject = audioGraph.mixedOut.stream;
    audioGraph.mixedAudio.autoplay = true;

    applyMasterAudioParams();
  }

  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (_) {}
  }
}

async function ensureOutputBridge(contextKey, sourceKey, gainKey, stream) {
  if (!audioGraph[contextKey]) {
    audioGraph[contextKey] = new AudioContext({ latencyHint: "interactive" });
  }

  const outputCtx = audioGraph[contextKey];
  if (outputCtx.state === "suspended") {
    try {
      await outputCtx.resume();
    } catch (_) {}
  }

  if (!audioGraph[sourceKey] || !audioGraph[gainKey]) {
    const source = outputCtx.createMediaStreamSource(stream);
    const gain = outputCtx.createGain();
    source.connect(gain).connect(outputCtx.destination);
    audioGraph[sourceKey] = source;
    audioGraph[gainKey] = gain;
  }
}

async function applySinkToOutputBridge(contextKey, gainKey, deviceId) {
  const outputCtx = audioGraph[contextKey];
  const outputGain = audioGraph[gainKey];
  if (!outputCtx || !outputGain) return false;

  if (typeof outputCtx.setSinkId !== "function") {
    outputGain.gain.value = deviceId ? 1 : 0;
    return false;
  }

  try {
    if (deviceId) {
      await outputCtx.setSinkId(deviceId);
      outputGain.gain.value = 1;
    } else {
      outputGain.gain.value = 0;
    }
    return true;
  } catch (_) {
    outputGain.gain.value = 0;
    return false;
  }
}

async function applyOutputSinkIds() {
  if (!audioGraph.monitorAudio || !audioGraph.monitor2Audio || !audioGraph.mixedAudio) return;
  applyAllInputRouteGains();

  await ensureOutputBridge("monitorOutputCtx", "monitorOutputSource", "monitorOutputGain", audioGraph.monitorOut.stream);
  await ensureOutputBridge("monitor2OutputCtx", "monitor2OutputSource", "monitor2OutputGain", audioGraph.monitor2Out.stream);
  await ensureOutputBridge("mixedOutputCtx", "mixedOutputSource", "mixedOutputGain", audioGraph.mixedOut.stream);

  const monitorBridgeApplied = await applySinkToOutputBridge("monitorOutputCtx", "monitorOutputGain", config.monitorDeviceId || "");
  const monitor2BridgeApplied = await applySinkToOutputBridge("monitor2OutputCtx", "monitor2OutputGain", config.monitor2DeviceId || "");
  const mixedBridgeApplied = await applySinkToOutputBridge("mixedOutputCtx", "mixedOutputGain", config.mixedOutputDeviceId || "");

  if (typeof audioGraph.monitorAudio.setSinkId === "function") {
    try {
      if (monitorBridgeApplied) {
        audioGraph.monitorAudio.volume = 0;
      } else if (config.monitorDeviceId) {
        audioGraph.monitorAudio.volume = 1;
        await audioGraph.monitorAudio.setSinkId(config.monitorDeviceId);
        if (audioGraph.monitorAudio.paused) {
          await audioGraph.monitorAudio.play().catch(() => {});
        }
      } else {
        audioGraph.monitorAudio.volume = 0;
      }
    } catch (error) {
      reportError("Monitor sink change", error, "Could not switch monitor output device.");
    }
  }

  if (typeof audioGraph.monitor2Audio.setSinkId === "function") {
    try {
      if (monitor2BridgeApplied) {
        audioGraph.monitor2Audio.volume = 0;
      } else if (config.monitor2DeviceId) {
        audioGraph.monitor2Audio.volume = 1;
        await audioGraph.monitor2Audio.setSinkId(config.monitor2DeviceId);
        if (audioGraph.monitor2Audio.paused) {
          await audioGraph.monitor2Audio.play().catch(() => {});
        }
      } else {
        audioGraph.monitor2Audio.volume = 0;
      }
    } catch (error) {
      reportError("Monitor 2 sink change", error, "Could not switch monitor 2 output device.");
    }
  }

  if (typeof audioGraph.mixedAudio.setSinkId === "function") {
    try {
      if (mixedBridgeApplied) {
        audioGraph.mixedAudio.volume = 0;
      } else if (config.mixedOutputDeviceId) {
        audioGraph.mixedAudio.volume = 1;
        await audioGraph.mixedAudio.setSinkId(config.mixedOutputDeviceId);
        if (audioGraph.mixedAudio.paused) {
          await audioGraph.mixedAudio.play().catch(() => {});
        }
      } else {
        audioGraph.mixedAudio.volume = 0;
      }
    } catch (error) {
      reportError("Mixed sink change", error, "Could not switch mixed output device.");
    }
  }
}

function applyInputRouteGains(index) {
  const inputCfg = getInputConfig(index);
  const route = audioGraph.inputRoutes[index];
  if (!route) return;
  const monitorTarget = (config.monitorDeviceId && !inputCfg.monitorMute) ? inputCfg.monitorVolume : 0;
  const monitor2Target = (config.monitor2DeviceId && !inputCfg.monitor2Mute) ? inputCfg.monitor2Volume : 0;
  const outputTarget = (config.mixedOutputDeviceId && !inputCfg.outputMute) ? inputCfg.outputVolume : 0;
  if (route.monitorGain) rampGain(route.monitorGain, monitorTarget);
  if (route.monitor2Gain) rampGain(route.monitor2Gain, monitor2Target);
  if (route.outputGain) rampGain(route.outputGain, outputTarget);
}

function applyAllInputRouteGains() {
  for (let i = 0; i < 3; i++) {
    if (audioGraph.inputRoutes[i]) applyInputRouteGains(i);
  }
}

async function rebuildInputRoute(index) {
  teardownRoute(index);
  releaseUnusedAppSources();

  const inputCfg = getInputConfig(index);
  if (!inputCfg.deviceId || inputCfg.enabled === false) return;

  await ensureAudioEngine();

  let stream;
  try {
    stream = await getOrCreateStream(inputCfg.deviceId);
  } catch (error) {
    reportError("Input capture", error, `Unable to access input ${index + 1}.`);
    return;
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const monitorGain = audioCtx.createGain();
  const monitor2Gain = audioCtx.createGain();
  const outputGain = audioCtx.createGain();
  const inputAnalyser = audioCtx.createAnalyser();
  inputAnalyser.fftSize = 256;

  let monoSplitter = null;
  let monoMerger = null;
  let routedNode = source;

  if (inputCfg.forceMono) {
    monoSplitter = audioCtx.createChannelSplitter(2);
    monoMerger = audioCtx.createChannelMerger(2);
    source.connect(monoSplitter);
    monoSplitter.connect(monoMerger, 0, 0);
    monoSplitter.connect(monoMerger, 0, 1);
    routedNode = monoMerger;
  }

  const monitorBusActive = !!config.monitorDeviceId;
  const monitor2BusActive = !!config.monitor2DeviceId;
  const outputBusActive = !!config.mixedOutputDeviceId;

  routedNode.connect(inputAnalyser);
  if (monitorBusActive) routedNode.connect(monitorGain).connect(audioGraph.eqInputMonitor);
  if (monitor2BusActive) routedNode.connect(monitor2Gain).connect(audioGraph.eqInputMonitor2);
  if (outputBusActive) routedNode.connect(outputGain).connect(audioGraph.eqInputOutput);

  audioGraph.inputRoutes[index] = {
    source,
    monoSplitter,
    monoMerger,
    monitorGain: monitorBusActive ? monitorGain : null,
    monitor2Gain: monitor2BusActive ? monitor2Gain : null,
    outputGain: outputBusActive ? outputGain : null,
    inputAnalyser,
    meterBuffer: new Uint8Array(inputAnalyser.fftSize)
  };

  gainMap.perInput[index] = {
    monitorGain: monitorBusActive ? monitorGain : null,
    monitor2Gain: monitor2BusActive ? monitor2Gain : null,
    outputGain: outputBusActive ? outputGain : null
  };
  applyInputRouteGains(index);
}

function clampDb(db) {
  if (!Number.isFinite(db)) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, Math.min(0, db));
}

function getAnalyserDb(analyser, buffer) {
  if (!analyser || !buffer) return METER_FLOOR_DB;
  analyser.getByteTimeDomainData(buffer);
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const centered = (buffer[i] - 128) / 128;
    const abs = Math.abs(centered);
    if (abs > peak) peak = abs;
  }
  if (peak <= 0.00001) return METER_FLOOR_DB;
  return clampDb(20 * Math.log10(peak));
}

function updateMeterVisual(fillElement, textElement, db) {
  if (!fillElement || !textElement) return;
  const normalized = (db - METER_FLOOR_DB) / Math.abs(METER_FLOOR_DB);
  const clamped = Math.max(0, Math.min(1, normalized));
  const hiddenPercent = (1 - clamped) * 100;
  fillElement.style.clipPath = `inset(0 ${hiddenPercent}% 0 0)`;
  fillElement.style.opacity = clamped <= 0 ? "0" : "1";
  const displayDb = Math.max(0, db - METER_FLOOR_DB);
  textElement.textContent = `${displayDb.toFixed(1)} dB`;
}

function updateClipIndicator(element, db, bucket, inputIndex = -1) {
  if (!element) return;
  const now = Date.now();
  const displayDb = Math.max(0, db - METER_FLOOR_DB);
  const clipThreshold = 39;

  if (displayDb >= clipThreshold) {
    if (bucket === "inputs" && inputIndex >= 0) {
      clipHoldUntil.inputs[inputIndex] = now + 700;
    } else {
      clipHoldUntil[bucket] = now + 700;
    }
  }

  const active = bucket === "inputs"
    ? now < clipHoldUntil.inputs[inputIndex]
    : now < clipHoldUntil[bucket];

  element.classList.toggle("active", active);
}

function updateMeters() {
  const monitorDb = audioGraph.monitorMeterBuffer ? getAnalyserDb(audioGraph.monitorMeterAnalyser, audioGraph.monitorMeterBuffer) : METER_FLOOR_DB;
  const monitor2Db = audioGraph.monitor2MeterBuffer ? getAnalyserDb(audioGraph.monitor2MeterAnalyser, audioGraph.monitor2MeterBuffer) : METER_FLOOR_DB;
  const outputDb = audioGraph.outputMeterBuffer ? getAnalyserDb(audioGraph.outputMeterAnalyser, audioGraph.outputMeterBuffer) : METER_FLOOR_DB;
  updateMeterVisual(ui.monitorMeterFill, ui.monitorMeterText, monitorDb);
  updateMeterVisual(ui.monitor2MeterFill, ui.monitor2MeterText, monitor2Db);
  updateMeterVisual(ui.outputMeterFill, ui.outputMeterText, outputDb);
  updateClipIndicator(ui.monitorClip, monitorDb, "monitor");
  updateClipIndicator(ui.monitor2Clip, monitor2Db, "monitor2");
  updateClipIndicator(ui.outputClip, outputDb, "output");

  for (let i = 0; i < 3; i++) {
    const refs = sourceCardRefs[i];
    if (!refs || !refs.meterFill || !refs.meterText) continue;
    const route = audioGraph.inputRoutes[i];
    const db = route ? getAnalyserDb(route.inputAnalyser, route.meterBuffer) : METER_FLOOR_DB;
    updateMeterVisual(refs.meterFill, refs.meterText, db);
    updateClipIndicator(refs.clip, db, "inputs", i);
  }
}

function renderSourceCard(index) {
  const inputCfg = getInputConfig(index);
  const deviceId = inputCfg.deviceId;
  const label = historicalDeviceLabels[deviceId] || `Input ${index + 1}`;

  const card = document.createElement("div");
  card.classList.add("source-card");
  card.classList.toggle("input-disabled", inputCfg.enabled === false);

  if (!deviceId) {
    card.innerHTML = `<h3>Input ${index + 1}</h3><p>(No device selected)</p>`;
    sourceCardRefs[index] = null;
    return card;
  }

  card.innerHTML = `
    <h3>${label}</h3>
    <div class="input-meter">
      <span>Level</span>
      <div class="meterTrack"><div class="meterFill inputMeterFill"></div></div>
      <span class="meterMeta"><span class="input-meter-text meterValue inputMeterText">0.0 dB</span><span class="clipIndicator inputClip">CLIP</span></span>
    </div>
    <div class="source-details">
    <label><input type="checkbox" class="inputEnabled" ${inputCfg.enabled === false ? "" : "checked"}> Enable Input</label><br>
    <label>Monitor Volume:
      <input type="range" min="0" max="1" step="0.01" value="${inputCfg.monitorVolume}" class="monitorVol">
      <span class="monitorVolDisplay">${Math.round(inputCfg.monitorVolume * 100)}%</span>
    </label>
    <label><input type="checkbox" class="monitorMute" ${inputCfg.monitorMute ? "checked" : ""}> Mute Monitor</label><br>
    <label>Monitor 2 Volume:
      <input type="range" min="0" max="1" step="0.01" value="${inputCfg.monitor2Volume}" class="monitor2Vol">
      <span class="monitor2VolDisplay">${Math.round(inputCfg.monitor2Volume * 100)}%</span>
    </label>
    <label><input type="checkbox" class="monitor2Mute" ${inputCfg.monitor2Mute ? "checked" : ""}> Mute Monitor 2</label><br>
    <label>Output Volume:
      <input type="range" min="0" max="1" step="0.01" value="${inputCfg.outputVolume}" class="outputVol">
      <span class="outputVolDisplay">${Math.round(inputCfg.outputVolume * 100)}%</span>
    </label>
    <label><input type="checkbox" class="outputMute" ${inputCfg.outputMute ? "checked" : ""}> Mute Output</label><br>
    <label><input type="checkbox" class="forceMono" ${inputCfg.forceMono ? "checked" : ""}> Force Mono</label>
    </div>
  `;

  const inputEnabled = card.querySelector(".inputEnabled");
  const monVol = card.querySelector(".monitorVol");
  const mon2Vol = card.querySelector(".monitor2Vol");
  const outVol = card.querySelector(".outputVol");
  const monMute = card.querySelector(".monitorMute");
  const mon2Mute = card.querySelector(".monitor2Mute");
  const outMute = card.querySelector(".outputMute");
  const monoBox = card.querySelector(".forceMono");
  const inputMeterFill = card.querySelector(".inputMeterFill");
  const inputMeterText = card.querySelector(".inputMeterText");
  const inputClip = card.querySelector(".inputClip");

  sourceCardRefs[index] = {
    meterFill: inputMeterFill,
    meterText: inputMeterText,
    clip: inputClip
  };

  inputEnabled.onchange = () => {
    inputCfg.enabled = inputEnabled.checked;
    card.classList.toggle("input-disabled", inputCfg.enabled === false);
    saveInputStateByIndex(index);
    saveConfig();
    setStatus(`Input ${index + 1} ${inputCfg.enabled ? "enabled" : "disabled"}`);
    queueRebuildInputRoute(index, false);
  };

  monVol.oninput = () => {
    inputCfg.monitorVolume = parseFloat(monVol.value);
    monVol.nextElementSibling.textContent = `${Math.round(inputCfg.monitorVolume * 100)}%`;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  mon2Vol.oninput = () => {
    inputCfg.monitor2Volume = parseFloat(mon2Vol.value);
    mon2Vol.nextElementSibling.textContent = `${Math.round(inputCfg.monitor2Volume * 100)}%`;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  outVol.oninput = () => {
    inputCfg.outputVolume = parseFloat(outVol.value);
    outVol.nextElementSibling.textContent = `${Math.round(inputCfg.outputVolume * 100)}%`;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  monMute.onchange = () => {
    inputCfg.monitorMute = monMute.checked;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  mon2Mute.onchange = () => {
    inputCfg.monitor2Mute = mon2Mute.checked;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  outMute.onchange = () => {
    inputCfg.outputMute = outMute.checked;
    applyInputRouteGains(index);
    saveInputStateByIndex(index);
    saveConfig();
  };

  monoBox.onchange = () => {
    inputCfg.forceMono = monoBox.checked;
    saveInputStateByIndex(index);
    saveConfig();
    queueRebuildInputRoute(index, false);
  };

  return card;
}

function renderSourceCards() {
  ui.sources.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    ui.sources.appendChild(renderSourceCard(i));
  }
}

async function buildAudioGraph() {
  for (let i = 0; i < 3; i++) {
    teardownRoute(i);
  }
  releaseUnusedAppSources();

  renderSourceCards();

  const activeInputIndexes = [0, 1, 2].filter(index => {
    const input = getInputConfig(index);
    return !!input.deviceId && input.enabled !== false;
  });
  if (activeInputIndexes.length === 0) return;

  for (const index of activeInputIndexes) {
    await rebuildInputRoute(index);
  }

  applyMasterAudioParams();
  await applyOutputSinkIds();
}

function applyDeviceStateToInput(index, deviceId) {
  if (!deviceId) return;
  const existing = deviceStates[deviceId];
  if (!existing) return;
  Object.assign(getInputConfig(index), existing, { deviceId });
}

function makeOptions(select, devices, emptyLabel) {
  const currentValue = select.value;
  select.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.appendChild(empty);

  let appGroup = null;
  devices.forEach(device => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Unnamed ${device.kind === "audioinput" ? "Input" : "Output"}`;
    option.dataset.baseLabel = option.textContent;
    if (device.kind === "appaudio") {
      if (device.title) option.title = device.title;
      if (!appGroup) {
        appGroup = document.createElement("optgroup");
        appGroup.label = "Applications";
        select.appendChild(appGroup);
      }
      appGroup.appendChild(option);
      return;
    }
    select.appendChild(option);
  });

  select.value = currentValue;
}

function getAllRoutingSelects() {
  return [...ui.inputSels, ui.monitorSel, ui.monitor2Sel, ui.mixedSel].filter(Boolean);
}

function getOptionBaseLabel(option) {
  if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent || "";
  return option.dataset.baseLabel;
}

function clearOptionDisabledReason(option) {
  if (!option) return;
  const baseLabel = getOptionBaseLabel(option);
  option.dataset.disabledReason = "";
  option.textContent = baseLabel;
  option.title = "";
  option.disabled = false;
}

function setOptionDisabledReason(option, reason) {
  if (!option || !option.value || !reason) return;
  const baseLabel = getOptionBaseLabel(option);
  option.dataset.disabledReason = reason;
  option.textContent = `${baseLabel} — ${reason}`;
  option.title = reason;
  option.disabled = true;
}

function resetRoutingOptionStates() {
  getAllRoutingSelects().forEach(select => {
    Array.from(select.options).forEach(option => {
      if (!option.value) {
        option.disabled = false;
        option.title = "";
        option.dataset.disabledReason = "";
        return;
      }
      clearOptionDisabledReason(option);
    });
  });
}

function getCableDescriptor(label = "") {
  const normalized = String(label || "").toLowerCase();
  if (!normalized.includes("cable")) return null;
  const match = normalized.match(/cable(?:\s*[-_]\s*([a-z0-9]+)|\s+([a-z0-9]+))?\s*(input|output)\b/);
  if (!match) return null;
  const variant = (match[1] || match[2] || "").trim();
  const side = match[3];
  if (!side) return null;
  return {
    familyKey: `cable:${variant || "default"}`,
    side
  };
}

function getOppositeCableSide(side) {
  return side === "input" ? "output" : side === "output" ? "input" : "";
}

function getSelectedCableEntries(selects, devicesById) {
  const entries = [];
  selects.forEach(select => {
    const deviceId = select?.value || "";
    if (!deviceId) return;
    const device = devicesById.get(deviceId);
    if (!device) return;
    const descriptor = getCableDescriptor(device.label || "");
    if (!descriptor) return;
    entries.push({
      ...descriptor,
      label: device.label || "Cable device"
    });
  });
  return entries;
}

function applyCableLoopRestrictions({ notify = false } = {}) {
  const inputsById = new Map(cachedInputDevices.map(device => [device.deviceId, device]));
  const outputsById = new Map(cachedOutputDevices.map(device => [device.deviceId, device]));
  const selectedInputEntries = getSelectedCableEntries(ui.inputSels, inputsById);
  const outputSelects = [ui.monitorSel, ui.monitor2Sel, ui.mixedSel].filter(Boolean);
  const selectedOutputEntries = getSelectedCableEntries(outputSelects, outputsById);
  const toastReasonsShown = new Set();

  const blockConflictingOptions = (selects, deviceMap, opposingEntries, sideContextLabel) => {
    selects.forEach(select => {
      Array.from(select.options).forEach(option => {
        if (!option.value) return;
        const device = deviceMap.get(option.value);
        if (!device) return;
        const descriptor = getCableDescriptor(device.label || "");
        if (!descriptor) return;

        const conflict = opposingEntries.find(entry => {
          return entry.familyKey === descriptor.familyKey && entry.side === getOppositeCableSide(descriptor.side);
        });
        if (!conflict) return;

        const reason = `Disabled to prevent cable loop with ${conflict.label}`;
        setOptionDisabledReason(option, reason);

        if (select.value === option.value) {
          select.value = "";
          if (notify && !toastReasonsShown.has(reason)) {
            toastReasonsShown.add(reason);
            showToast(`${sideContextLabel}: ${reason}.`, "error", 4200);
          }
        }
      });
    });
  };

  blockConflictingOptions(outputSelects, outputsById, selectedInputEntries, "Output routing changed");
  blockConflictingOptions(ui.inputSels, inputsById, selectedOutputEntries, "Input routing changed");
}

function enforceUniqueSelectionGroup(selects, duplicateReason) {
  if (!Array.isArray(selects) || !selects.length) return;

  const seen = new Set();
  selects.forEach(select => {
    const value = select?.value || "";
    if (!value) return;
    if (seen.has(value)) {
      select.value = "";
      return;
    }
    seen.add(value);
  });

  selects.forEach((select, index) => {
    if (!select) return;
    const selectedElsewhere = new Set(
      selects
        .filter((other, otherIndex) => other && otherIndex !== index)
        .map(other => other.value)
        .filter(Boolean)
    );

    Array.from(select.options).forEach(option => {
      if (!option.value) return;
      if (selectedElsewhere.has(option.value)) {
        if (!option.dataset.disabledReason) {
          setOptionDisabledReason(option, duplicateReason);
        }
        return;
      }
      if (!option.dataset.disabledReason) {
        clearOptionDisabledReason(option);
      }
    });
  });
}

function enforceRoutingSelectionRules({ notify = false } = {}) {
  resetRoutingOptionStates();
  if (config.enforceRoutingSafety === false) return;
  applyCableLoopRestrictions({ notify });
  enforceUniqueSelectionGroup(ui.inputSels, "Already selected on another input");
  enforceUniqueSelectionGroup([ui.monitorSel, ui.monitor2Sel, ui.mixedSel], "Already selected on another output");
}

function syncRoutingConfigFromSelectors() {
  for (let i = 0; i < 3; i++) {
    getInputConfig(i).deviceId = ui.inputSels[i].value || "";
  }
  config.monitorDeviceId = ui.monitorSel.value || "";
  config.monitor2DeviceId = ui.monitor2Sel.value || "";
  config.mixedOutputDeviceId = ui.mixedSel.value || "";
}

function findInputReplacement(oldDeviceId, inputs, usedIds) {
  const oldLabel = historicalDeviceLabels[oldDeviceId] || deviceStates[oldDeviceId]?.label;
  if (!oldLabel) return "";
  const match = inputs.find(device => device.label === oldLabel && !usedIds.has(device.deviceId));
  return match ? match.deviceId : "";
}

function findOutputReplacement(oldDeviceId, outputs) {
  const oldLabel = historicalDeviceLabels[oldDeviceId];
  if (!oldLabel) return "";
  const match = outputs.find(device => device.label === oldLabel);
  return match ? match.deviceId : "";
}

function isReservedDeviceId(deviceId) {
  return deviceId === "default" || deviceId === "communications";
}

async function refreshDeviceLists({ rebindMissing = true, notify = false } = {}) {
  setStatus("Refreshing devices...");
  const devices = await navigator.mediaDevices.enumerateDevices();
  const allInputs = devices.filter(d => d.kind === "audioinput" && !isReservedDeviceId(d.deviceId));
  const selectedInputIds = new Set([0, 1, 2].map(index => getInputConfig(index).deviceId).filter(Boolean));
  const inputCounts = await Promise.all(allInputs.map(async device => {
    const inferred = inferChannelsFromLabel(device.label);
    if (config.showMultichannelDevices) return inferred;
    if (inferred <= 2) return inferred;
    if (!selectedInputIds.has(device.deviceId)) return inferred;
    return getInputDeviceChannelCount(device.deviceId, { allowProbe: true });
  }));
  cachedAppSources = await listAppSources();
  const inputs = [
    ...allInputs.filter((_, idx) => config.showMultichannelDevices || inputCounts[idx] <= 2),
    ...cachedAppSources
  ];
  const allOutputs = devices.filter(d => d.kind === "audiooutput" && !isReservedDeviceId(d.deviceId));
  const outputs = allOutputs.filter(device => config.showMultichannelDevices || getOutputDeviceChannelCount(device) <= 2);
  cachedInputDevices = inputs;
  cachedOutputDevices = outputs;

  inputs.forEach(device => {
    historicalDeviceLabels[device.deviceId] = device.label || "Unnamed Input";
  });
  outputs.forEach(device => {
    historicalDeviceLabels[device.deviceId] = device.label || "Unnamed Output";
  });

  ui.inputSels.forEach(select => makeOptions(select, inputs, "(None)"));
  makeOptions(ui.monitorSel, outputs, "(None)");
  makeOptions(ui.monitor2Sel, outputs, "(None)");
  makeOptions(ui.mixedSel, outputs, "(None)");

  const validInputIds = new Set(inputs.map(d => d.deviceId));
  const usedInputIds = new Set();
  const changedInputIndexes = [];

  for (let i = 0; i < 3; i++) {
    const cfg = getInputConfig(i);
    if (isReservedDeviceId(cfg.deviceId)) {
      cfg.deviceId = "";
    }
    if (cfg.deviceId && validInputIds.has(cfg.deviceId)) {
      usedInputIds.add(cfg.deviceId);
      continue;
    }

    if (!cfg.deviceId) continue;

    let replacement = "";
    if (rebindMissing) {
      replacement = findInputReplacement(cfg.deviceId, inputs, usedInputIds);
    }

    const oldDeviceId = cfg.deviceId;
    cfg.deviceId = replacement;

    if (replacement) {
      usedInputIds.add(replacement);
      if (deviceStates[oldDeviceId] && !deviceStates[replacement]) {
        deviceStates[replacement] = {
          ...deviceStates[oldDeviceId],
          deviceId: replacement,
          label: historicalDeviceLabels[replacement]
        };
      }
      applyDeviceStateToInput(i, replacement);
      if (notify) showToast(`Input ${i + 1} auto-rebound to ${historicalDeviceLabels[replacement]}.`, "success");
    } else {
      if (notify) showToast(`Input ${i + 1} device disconnected.`, "error");
    }

    changedInputIndexes.push(i);
  }

  const validOutputIds = new Set(outputs.map(d => d.deviceId));
  if (isReservedDeviceId(config.monitorDeviceId)) config.monitorDeviceId = "";
  if (isReservedDeviceId(config.monitor2DeviceId)) config.monitor2DeviceId = "";
  if (isReservedDeviceId(config.mixedOutputDeviceId)) config.mixedOutputDeviceId = "";

  if (config.monitorDeviceId && !validOutputIds.has(config.monitorDeviceId)) {
    const replacement = rebindMissing ? findOutputReplacement(config.monitorDeviceId, outputs) : "";
    config.monitorDeviceId = replacement || "";
    if (notify) showToast("Monitor output changed due to device update.", replacement ? "success" : "error");
  }

  if (config.monitor2DeviceId && !validOutputIds.has(config.monitor2DeviceId)) {
    const replacement = rebindMissing ? findOutputReplacement(config.monitor2DeviceId, outputs) : "";
    config.monitor2DeviceId = replacement || "";
    if (notify) showToast("Monitor 2 output changed due to device update.", replacement ? "success" : "error");
  }

  if (config.mixedOutputDeviceId && !validOutputIds.has(config.mixedOutputDeviceId)) {
    const replacement = rebindMissing ? findOutputReplacement(config.mixedOutputDeviceId, outputs) : "";
    config.mixedOutputDeviceId = replacement || "";
    if (notify) showToast("Mixed output changed due to device update.", replacement ? "success" : "error");
  }

  for (let i = 0; i < 3; i++) {
    ui.inputSels[i].value = getInputConfig(i).deviceId || "";
  }
  ui.monitorSel.value = config.monitorDeviceId || "";
  ui.monitor2Sel.value = config.monitor2DeviceId || "";
  ui.mixedSel.value = config.mixedOutputDeviceId || "";

  enforceRoutingSelectionRules({ notify: false });
  syncRoutingConfigFromSelectors();

  window.deviceStateAPI.saveState(deviceStates);
  saveConfig();

  if (changedInputIndexes.length) {
    for (const index of changedInputIndexes) {
      await queueRebuildInputRoute(index, true);
    }
  }

  await applyOutputSinkIds();
  setStatus(`Ready • ${inputs.length} inputs, ${outputs.length} outputs`);
}

function scheduleInputRecovery(deviceId, reason) {
  if (!deviceId) return;
  if (recoveryDebounceMap[deviceId]) clearTimeout(recoveryDebounceMap[deviceId]);
  recoveryDebounceMap[deviceId] = setTimeout(async () => {
    try {
      const indexes = [0, 1, 2].filter(index => getInputConfig(index).deviceId === deviceId);
      if (!indexes.length) return;
      for (const index of indexes) {
        await queueRebuildInputRoute(index, false);
      }
      setStatus(`Recovered ${historicalDeviceLabels[deviceId] || "input"}`);
      showToast(`Recovered ${historicalDeviceLabels[deviceId] || "input"} (${reason}).`, "success");
    } catch (error) {
      reportError("Input recovery", error, "Automatic input recovery failed.");
    }
  }, 250);
}

function startHealthWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    for (let i = 0; i < 3; i++) {
      const cfg = getInputConfig(i);
      if (!cfg.deviceId) continue;
      const stream = activeStreams[cfg.deviceId];
      if (!hasLiveTrack(stream)) {
        scheduleInputRecovery(cfg.deviceId, "watchdog");
      }
    }
  }, 3000);
}

function startMeterLoop() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = setInterval(updateMeters, 90);
}

async function setupDevControls() {
  const devControls = document.getElementById("devControls");
  const runButton = document.getElementById("runMonoStress");
  const inputSelect = document.getElementById("monoStressInput");
  const countInput = document.getElementById("monoStressCount");
  const status = document.getElementById("monoStressStatus");

  if (!devControls || !runButton || !inputSelect || !countInput || !status) return;

  let isDev = false;
  if (window.appAPI && typeof window.appAPI.isDev === "function") {
    try {
      isDev = await window.appAPI.isDev();
    } catch (_) {
      isDev = false;
    }
  }
  if (!isDev) return;

  devControls.hidden = false;

  runButton.onclick = async () => {
    if (monoStressRunning) return;
    const inputIndex = parseInt(inputSelect.value, 10);
    const inputCfg = getInputConfig(inputIndex);
    if (!inputCfg.deviceId) {
      status.textContent = "Select a device for that input first.";
      return;
    }

    let toggleCount = parseInt(countInput.value, 10);
    if (!Number.isFinite(toggleCount)) toggleCount = 20;
    toggleCount = Math.max(2, Math.min(100, toggleCount));

    const originalMono = !!inputCfg.forceMono;
    monoStressRunning = true;
    runButton.disabled = true;

    try {
      status.textContent = `Running ${toggleCount} toggles...`;
      for (let i = 0; i < toggleCount; i++) {
        inputCfg.forceMono = !inputCfg.forceMono;
        saveInputStateByIndex(inputIndex);
        saveConfig();
        await queueRebuildInputRoute(inputIndex, false);
      }
      inputCfg.forceMono = originalMono;
      saveInputStateByIndex(inputIndex);
      saveConfig();
      await queueRebuildInputRoute(inputIndex, false);
      status.textContent = `Completed ${toggleCount} toggles successfully.`;
    } catch (error) {
      status.textContent = "Stress test failed; check console for details.";
      reportError("Mono stress test", error, "Mono stress test failed.");
    } finally {
      monoStressRunning = false;
      runButton.disabled = false;
    }
  };
}

function setupUiHandlers() {
  const onSelectionChange = debounce(async () => {
    enforceRoutingSelectionRules({ notify: true });

    const changedInputIndexes = [];

    for (let i = 0; i < 3; i++) {
      const cfg = getInputConfig(i);
      const previousId = cfg.deviceId;
      const nextId = ui.inputSels[i].value;
      if (previousId === nextId) continue;

      cfg.deviceId = nextId;
      if (nextId) applyDeviceStateToInput(i, nextId);
      changedInputIndexes.push(i);
    }

    const monitorChanged = config.monitorDeviceId !== ui.monitorSel.value;
    const monitor2Changed = config.monitor2DeviceId !== ui.monitor2Sel.value;
    const mixedChanged = config.mixedOutputDeviceId !== ui.mixedSel.value;
    config.monitorDeviceId = ui.monitorSel.value;
    config.monitor2DeviceId = ui.monitor2Sel.value;
    config.mixedOutputDeviceId = ui.mixedSel.value;

    enforceRoutingSelectionRules({ notify: true });
    syncRoutingConfigFromSelectors();

    saveConfig();

    for (const index of changedInputIndexes) {
      await queueRebuildInputRoute(index, true);
    }

    if (monitorChanged || monitor2Changed || mixedChanged) {
      await queueBuildAudioGraph();
    }

    setStatus("Routing updated");
  }, 80);

  ui.inputSels.forEach(select => {
    select.onchange = onSelectionChange;
  });

  if (ui.refreshAppSources) {
    ui.refreshAppSources.onclick = async () => {
      try {
        await refreshDeviceLists({ rebindMissing: true, notify: true });
        if (!appAudioSupported) {
          showToast("Per-application capture requires Windows 10 (2004+) x64.", "error");
        } else {
          setStatus(`Found ${cachedAppSources.length} application source(s)`);
        }
      } catch (error) {
        reportError("Application refresh", error, "Failed to refresh application sources.");
      }
    };
  }
  ui.monitorSel.onchange = onSelectionChange;
  ui.monitor2Sel.onchange = onSelectionChange;
  ui.mixedSel.onchange = onSelectionChange;

  if (ui.compactModeToggle) {
    ui.compactModeToggle.onchange = () => {
      config.compactMode = ui.compactModeToggle.checked;
      applyCompactMode(config.compactMode);
      saveConfig();
      setStatus(config.compactMode ? "Compact mode enabled" : "Compact mode disabled");
    };
  }

  if (ui.showMultichannelDevicesToggle) {
    ui.showMultichannelDevicesToggle.onchange = async () => {
      config.showMultichannelDevices = ui.showMultichannelDevicesToggle.checked;
      saveConfig();
      setStatus(config.showMultichannelDevices
        ? "Showing all input/output channel counts"
        : "Showing mono/stereo input/output devices only");
      await refreshDeviceLists({ rebindMissing: false, notify: false });
    };
  }

  if (ui.enforceRoutingSafetyToggle) {
    ui.enforceRoutingSafetyToggle.onchange = async () => {
      const previousInputIds = [0, 1, 2].map(index => getInputConfig(index).deviceId || "");
      const previousOutputs = {
        monitorDeviceId: config.monitorDeviceId || "",
        monitor2DeviceId: config.monitor2DeviceId || "",
        mixedOutputDeviceId: config.mixedOutputDeviceId || ""
      };

      config.enforceRoutingSafety = ui.enforceRoutingSafetyToggle.checked;
      enforceRoutingSelectionRules({ notify: config.enforceRoutingSafety });
      syncRoutingConfigFromSelectors();
      saveConfig();

      const changedInputIndexes = [0, 1, 2].filter(index => previousInputIds[index] !== getInputConfig(index).deviceId);
      for (const index of changedInputIndexes) {
        await queueRebuildInputRoute(index, true);
      }

      const outputChanged = previousOutputs.monitorDeviceId !== config.monitorDeviceId
        || previousOutputs.monitor2DeviceId !== config.monitor2DeviceId
        || previousOutputs.mixedOutputDeviceId !== config.mixedOutputDeviceId;
      if (outputChanged) {
        await applyOutputSinkIds();
      }

      setStatus(config.enforceRoutingSafety ? "Routing safety restrictions enabled" : "Routing safety restrictions bypassed");
    };
  }

  if (ui.startOnBootToggle && window.appAPI && typeof window.appAPI.setStartOnBoot === "function") {
    ui.startOnBootToggle.onchange = async () => {
      try {
        const applied = await window.appAPI.setStartOnBoot(ui.startOnBootToggle.checked);
        ui.startOnBootToggle.checked = !!applied;
        setStatus(applied ? "Start on boot enabled" : "Start on boot disabled");
      } catch (error) {
        reportError("Start on boot", error, "Failed to update start on boot setting.");
      }
    };
  }

  ui.monitorMasterSlider.oninput = () => {
    config.monitorMasterVolume = parseFloat(ui.monitorMasterSlider.value);
    ui.monitorMasterDisplay.textContent = `${Math.round(config.monitorMasterVolume * 100)}%`;
    applyMasterAudioParams();
    saveConfig();
  };

  ui.monitor2MasterSlider.oninput = () => {
    config.monitor2MasterVolume = parseFloat(ui.monitor2MasterSlider.value);
    ui.monitor2MasterDisplay.textContent = `${Math.round(config.monitor2MasterVolume * 100)}%`;
    applyMasterAudioParams();
    saveConfig();
  };

  ui.outputMasterSlider.oninput = () => {
    config.outputMasterVolume = parseFloat(ui.outputMasterSlider.value);
    ui.outputMasterDisplay.textContent = `${Math.round(config.outputMasterVolume * 100)}%`;
    applyMasterAudioParams();
    saveConfig();
  };

  const updateEqFromSliders = () => {
    config.eq.low = parseFloat(ui.eqLowSlider.value);
    config.eq.mid = parseFloat(ui.eqMidSlider.value);
    config.eq.high = parseFloat(ui.eqHighSlider.value);
    applyUiFromConfig();
    applyMasterAudioParams();
    saveConfig();
  };

  ui.eqLowSlider.oninput = updateEqFromSliders;
  ui.eqMidSlider.oninput = updateEqFromSliders;
  ui.eqHighSlider.oninput = updateEqFromSliders;

  if (ui.eqPresetSelect) {
    ui.eqPresetSelect.onchange = () => {
      const value = ui.eqPresetSelect.value;
      if (value.startsWith("custom:")) {
        const preset = findEqCustomPreset(value.slice(7));
        if (preset) {
          applyEqValues(preset.values);
          if (ui.eqPresetName) ui.eqPresetName.value = preset.name;
        }
        return;
      }

      const builtIn = BUILTIN_EQ_PRESETS[value];
      if (builtIn) {
        applyEqValues(builtIn);
        if (ui.eqPresetName) ui.eqPresetName.value = "";
      }
    };
  }

  if (ui.eqPresetSave) {
    ui.eqPresetSave.onclick = () => {
      const name = (ui.eqPresetName?.value || "").trim();
      if (!name) {
        showToast("Enter a custom EQ preset name first.", "error");
        return;
      }

      const values = { ...config.eq };
      const existingIndex = config.eqCustomPresets.findIndex(item => item.name.toLowerCase() === name.toLowerCase());
      if (existingIndex >= 0) {
        config.eqCustomPresets[existingIndex] = { name, values };
      } else {
        config.eqCustomPresets.push({ name, values });
      }

      refreshEqPresetSelect(`custom:${name}`);
      saveConfig();
      showToast(`Saved EQ preset: ${name}`, "success");
    };
  }

  if (ui.eqPresetDelete) {
    ui.eqPresetDelete.onclick = () => {
      const value = ui.eqPresetSelect?.value || "";
      if (!value.startsWith("custom:")) {
        showToast("Select a custom EQ preset to delete.", "error");
        return;
      }

      const name = value.slice(7);
      config.eqCustomPresets = config.eqCustomPresets.filter(item => item.name !== name);
      refreshEqPresetSelect("flat");
      if (ui.eqPresetName) ui.eqPresetName.value = "";
      applyEqValues(BUILTIN_EQ_PRESETS.flat);
      showToast(`Deleted EQ preset: ${name}`, "success");
    };
  }

  ui.overloadSlider.oninput = () => {
    config.overloadGain = parseFloat(ui.overloadSlider.value);
    ui.overloadDisplay.textContent = `${Math.round(config.overloadGain * 100)}%`;
    applyMasterAudioParams();
    saveConfig();
  };

  const resetButton = document.getElementById("resetAdvanced");
  if (resetButton) {
    resetButton.onclick = () => {
      config.eq = { ...BUILTIN_EQ_PRESETS.flat };
      config.overloadGain = 1;
      applyUiFromConfig();
      applyMasterAudioParams();
      refreshEqPresetSelect("flat");
      saveConfig();
    };
  }

  if (ui.presetSave) {
    ui.presetSave.onclick = () => {
      const name = (ui.presetName?.value || ui.presetSelect?.value || "").trim();
      if (!name) {
        showToast("Enter a preset name first.", "error");
        return;
      }
      upsertPreset(name, getPresetSnapshot());
      refreshPresetSelect(name);
      saveConfig();
      showToast(`Saved preset: ${name}`, "success");
    };
  }

  if (ui.presetLoad) {
    ui.presetLoad.onclick = async () => {
      const name = ui.presetSelect?.value || "";
      if (!name) {
        showToast("Select a preset to load.", "error");
        return;
      }
      await applyPresetByName(name);
    };
  }

  if (ui.presetDelete) {
    ui.presetDelete.onclick = () => {
      const name = ui.presetSelect?.value || "";
      if (!name) {
        showToast("Select a preset to delete.", "error");
        return;
      }
      config.presets = config.presets.filter(preset => preset.name !== name);
      refreshPresetSelect("");
      if (ui.presetName) ui.presetName.value = "";
      saveConfig();
      showToast(`Deleted preset: ${name}`, "success");
    };
  }

  if (ui.presetSelect) {
    ui.presetSelect.onchange = () => {
      if (ui.presetName) ui.presetName.value = ui.presetSelect.value || "";
    };
  }
}

async function setup() {
  try {
    setStatus("Initializing...");
    initialiseUiRefs();
    const loadedConfig = await window.configAPI.loadConfig();
    config = {
      ...config,
      ...loadedConfig,
      version: CONFIG_VERSION,
      monitorDeviceId: typeof loadedConfig?.monitorDeviceId === "string" ? loadedConfig.monitorDeviceId : "",
      monitor2DeviceId: typeof loadedConfig?.monitor2DeviceId === "string" ? loadedConfig.monitor2DeviceId : "",
      mixedOutputDeviceId: typeof loadedConfig?.mixedOutputDeviceId === "string" ? loadedConfig.mixedOutputDeviceId : "",
      monitorMasterVolume: Number.isFinite(loadedConfig?.monitorMasterVolume) ? loadedConfig.monitorMasterVolume : 1,
      monitor2MasterVolume: Number.isFinite(loadedConfig?.monitor2MasterVolume)
        ? loadedConfig.monitor2MasterVolume
        : (Number.isFinite(loadedConfig?.monitorMasterVolume) ? loadedConfig.monitorMasterVolume : 1),
      outputMasterVolume: Number.isFinite(loadedConfig?.outputMasterVolume) ? loadedConfig.outputMasterVolume : 1,
      compactMode: !!loadedConfig?.compactMode,
      showMultichannelDevices: !!loadedConfig?.showMultichannelDevices,
      enforceRoutingSafety: typeof loadedConfig?.enforceRoutingSafety === "boolean" ? loadedConfig.enforceRoutingSafety : true,
      eq: {
        low: Number.isFinite(loadedConfig?.eq?.low) ? loadedConfig.eq.low : (Number.isFinite(loadedConfig?.bassGain) ? loadedConfig.bassGain : 0),
        mid: Number.isFinite(loadedConfig?.eq?.mid) ? loadedConfig.eq.mid : 0,
        high: Number.isFinite(loadedConfig?.eq?.high) ? loadedConfig.eq.high : 0
      },
      eqCustomPresets: Array.isArray(loadedConfig.eqCustomPresets) ? loadedConfig.eqCustomPresets : [],
      presets: Array.isArray(loadedConfig.presets) ? loadedConfig.presets : [],
      inputs: Array.isArray(loadedConfig?.inputs)
        ? loadedConfig.inputs.map(input => {
          const normalized = { ...getDefaultInputConfig(), ...(input || {}) };
          const monitorVolume = Number.isFinite(normalized.monitorVolume) ? normalized.monitorVolume : 1;
          return {
            ...normalized,
            monitorVolume,
            monitor2Volume: Number.isFinite(normalized.monitor2Volume) ? normalized.monitor2Volume : monitorVolume,
            monitorMute: !!normalized.monitorMute,
            monitor2Mute: typeof normalized.monitor2Mute === "boolean" ? normalized.monitor2Mute : !!normalized.monitorMute,
            outputMute: !!normalized.outputMute,
            forceMono: !!normalized.forceMono,
            enabled: normalized.enabled !== false
          };
        })
        : [getDefaultInputConfig(), getDefaultInputConfig(), getDefaultInputConfig()],
    };

    deviceStates = await window.deviceStateAPI.loadState();

    for (let i = 0; i < 3; i++) {
      const inputCfg = getInputConfig(i);
      if (inputCfg.deviceId) applyDeviceStateToInput(i, inputCfg.deviceId);
    }

    applyUiFromConfig();
    if (ui.startOnBootToggle && window.appAPI && typeof window.appAPI.getStartOnBoot === "function") {
      try {
        ui.startOnBootToggle.checked = !!(await window.appAPI.getStartOnBoot());
      } catch (_) {
        ui.startOnBootToggle.checked = false;
      }
    }
    refreshPresetSelect();
    refreshEqPresetSelect();
    setupUiHandlers();
    await setupDevControls();
    await refreshDeviceLists({ rebindMissing: true, notify: false });
    renderSourceCards();

    const hasAnyInput = [0, 1, 2].some(index => !!getInputConfig(index).deviceId);
    if (hasAnyInput) {
      await queueBuildAudioGraph();
    }

    startMeterLoop();
    startHealthWatchdog();

    navigator.mediaDevices.addEventListener("devicechange", debounce(() => {
      setStatus("Device change detected...");
      refreshDeviceLists({ rebindMissing: true, notify: true }).catch(error => {
        reportError("Device refresh", error, "Failed to refresh devices after hardware change.");
      });
    }, 300));

  } catch (error) {
    reportError("Setup", error, "Failed to initialize Audio Mixer.");
  }
}

setup();
