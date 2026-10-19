"use strict";

// Config schema + migration. Pure module (no Electron imports) so it can be unit-tested.

const CONFIG_VERSION = 4;
const INPUT_COUNT = 3;
const BUS_IDS = ["monitor", "monitor2", "output"];
const MIN_DB = -60; // treated as silence (-inf)
const MAX_INPUT_DB = 24;
const MAX_BUS_DB = 12;
const LATENCY_HINTS = ["interactive", "balanced", "playback"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNum = value => typeof value === "number" && Number.isFinite(value);
const num = (value, fallback, min = -Infinity, max = Infinity) => (isNum(value) ? clamp(value, min, max) : fallback);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const str = (value, fallback = "") => (typeof value === "string" ? value : fallback);

function linearToDb(linear) {
  if (!isNum(linear) || linear <= 0) return MIN_DB;
  return clamp(Math.round(20 * Math.log10(linear) * 10) / 10, MIN_DB, MAX_INPUT_DB);
}

const defaultSend = () => ({ on: true, levelDb: 0 });

const defaultInput = () => ({
  deviceId: "",
  label: "",
  enabled: true,
  gainDb: 0,
  mute: false,
  solo: false,
  forceMono: false,
  sends: { monitor: defaultSend(), monitor2: defaultSend(), output: defaultSend() }
});

const defaultBus = () => ({ deviceId: "", label: "", volumeDb: 0, mute: false });

const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  inputs: Array.from({ length: INPUT_COUNT }, defaultInput),
  buses: { monitor: defaultBus(), monitor2: defaultBus(), output: defaultBus() },
  eq: { low: 0, mid: 0, high: 0 },
  eqCustomPresets: [],
  driveDb: 0,
  softClip: { enabled: true, thresholdDb: -6 },
  limiter: { enabled: true, ceilingDb: -1 },
  latencyHint: "balanced",
  showMultichannelDevices: false,
  enforceRoutingSafety: true,
  compactMode: false,
  closeToTray: true,
  presets: [],
  window: null
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function normalizeSend(raw, legacyVolume, legacyMute) {
  if (raw && typeof raw === "object") {
    return { on: bool(raw.on, true), levelDb: num(raw.levelDb, 0, MIN_DB, 0) };
  }
  return {
    on: !legacyMute,
    levelDb: isNum(legacyVolume) ? clamp(linearToDb(legacyVolume), MIN_DB, 0) : 0
  };
}

// Accepts both the v1-v3 flat input shape and the v4 shape.
function normalizeInput(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const sends = input.sends && typeof input.sends === "object" ? input.sends : {};
  const legacyMonitorVolume = input.monitorVolume;
  return {
    deviceId: str(input.deviceId),
    label: str(input.label),
    enabled: input.enabled !== false,
    gainDb: num(input.gainDb, 0, MIN_DB, MAX_INPUT_DB),
    mute: bool(input.mute, false),
    solo: bool(input.solo, false),
    forceMono: !!input.forceMono,
    sends: {
      monitor: normalizeSend(sends.monitor, legacyMonitorVolume, input.monitorMute),
      monitor2: normalizeSend(
        sends.monitor2,
        isNum(input.monitor2Volume) ? input.monitor2Volume : legacyMonitorVolume,
        typeof input.monitor2Mute === "boolean" ? input.monitor2Mute : input.monitorMute
      ),
      output: normalizeSend(sends.output, input.outputVolume, input.outputMute)
    }
  };
}

function normalizeEq(rawEq, legacyBass = 0) {
  const eq = rawEq && typeof rawEq === "object" ? rawEq : {};
  return {
    low: num(eq.low, num(legacyBass, 0), -12, 12),
    mid: num(eq.mid, 0, -12, 12),
    high: num(eq.high, 0, -12, 12)
  };
}

function normalizeBuses(raw) {
  const buses = raw.buses && typeof raw.buses === "object" ? raw.buses : {};
  const legacy = {
    monitor: { deviceId: raw.monitorDeviceId, volume: raw.monitorMasterVolume },
    monitor2: {
      deviceId: raw.monitor2DeviceId,
      volume: isNum(raw.monitor2MasterVolume) ? raw.monitor2MasterVolume : raw.monitorMasterVolume
    },
    output: { deviceId: raw.mixedOutputDeviceId, volume: raw.outputMasterVolume }
  };
  const result = {};
  BUS_IDS.forEach(id => {
    const bus = buses[id] && typeof buses[id] === "object" ? buses[id] : null;
    result[id] = bus
      ? { deviceId: str(bus.deviceId), label: str(bus.label), volumeDb: num(bus.volumeDb, 0, MIN_DB, MAX_BUS_DB), mute: bool(bus.mute, false) }
      : {
          deviceId: str(legacy[id].deviceId),
          label: "",
          volumeDb: isNum(legacy[id].volume) ? clamp(linearToDb(legacy[id].volume), MIN_DB, MAX_BUS_DB) : 0,
          mute: false
        };
    if (result[id].deviceId === "default" || result[id].deviceId === "communications") result[id].deviceId = "";
  });
  return result;
}

function normalizeDrive(raw) {
  if (isNum(raw.driveDb)) return clamp(raw.driveDb, 0, 12);
  if (isNum(raw.overloadGain)) return clamp(linearToDb(raw.overloadGain), 0, 12);
  return 0;
}

// A preset snapshot holds the mix (inputs, buses, eq, drive) but not app-level settings.
function normalizeSnapshot(rawSnapshot) {
  const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
  const inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
  return {
    inputs: Array.from({ length: INPUT_COUNT }, (_, i) => normalizeInput(inputs[i])),
    buses: normalizeBuses(snapshot),
    eq: normalizeEq(snapshot.eq, snapshot.bassGain),
    driveDb: normalizeDrive(snapshot)
  };
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, width, height } = raw;
  if (![width, height].every(isNum)) return null;
  return {
    x: isNum(x) ? Math.round(x) : undefined,
    y: isNum(y) ? Math.round(y) : undefined,
    width: Math.round(clamp(width, 760, 4000)),
    height: Math.round(clamp(height, 560, 3000)),
    maximized: !!raw.maximized
  };
}

function migrateConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const softClip = raw.softClip && typeof raw.softClip === "object" ? raw.softClip : {};
  const limiter = raw.limiter && typeof raw.limiter === "object" ? raw.limiter : {};

  return {
    version: CONFIG_VERSION,
    inputs: Array.from({ length: INPUT_COUNT }, (_, i) => normalizeInput(rawInputs[i])),
    buses: normalizeBuses(raw),
    eq: normalizeEq(raw.eq, raw.bassGain),
    eqCustomPresets: Array.isArray(raw.eqCustomPresets)
      ? raw.eqCustomPresets
          .filter(item => item && typeof item.name === "string" && item.name.trim() && item.values)
          .map(item => ({ name: item.name.trim().slice(0, 40), values: normalizeEq(item.values) }))
      : [],
    driveDb: normalizeDrive(raw),
    softClip: {
      enabled: bool(softClip.enabled, bool(raw.softClipEnabled, true)),
      thresholdDb: num(softClip.thresholdDb, num(raw.softClipThresholdDb, -6, -18, -0.5), -18, -0.5)
    },
    limiter: {
      enabled: bool(limiter.enabled, true),
      ceilingDb: num(limiter.ceilingDb, -1, -12, 0)
    },
    latencyHint: LATENCY_HINTS.includes(raw.latencyHint) ? raw.latencyHint : "balanced",
    showMultichannelDevices: bool(raw.showMultichannelDevices, false),
    enforceRoutingSafety: bool(raw.enforceRoutingSafety, true),
    compactMode: bool(raw.compactMode, false),
    closeToTray: bool(raw.closeToTray, true),
    presets: Array.isArray(raw.presets)
      ? raw.presets
          .filter(item => item && typeof item.name === "string" && item.name.trim() && item.snapshot)
          .map(item => ({ name: item.name.trim().slice(0, 40), snapshot: normalizeSnapshot(item.snapshot) }))
      : [],
    window: normalizeWindow(raw.window)
  };
}

function migrateDeviceStates(raw) {
  const result = {};
  if (!raw || typeof raw !== "object") return result;
  Object.entries(raw).forEach(([deviceId, state]) => {
    if (!deviceId || !state || typeof state !== "object") return;
    result[deviceId] = { ...normalizeInput({ ...state, deviceId }), label: str(state.label) };
  });
  return result;
}

module.exports = {
  CONFIG_VERSION,
  INPUT_COUNT,
  BUS_IDS,
  MIN_DB,
  MAX_INPUT_DB,
  MAX_BUS_DB,
  DEFAULT_CONFIG,
  cloneDefaults,
  defaultInput,
  linearToDb,
  normalizeInput,
  normalizeSnapshot,
  migrateConfig,
  migrateDeviceStates
};
