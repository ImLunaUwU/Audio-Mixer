const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const squirrelStartup = require('electron-squirrel-startup');
const { version } = require("./package.json");

const isDev = !app.isPackaged;
const BASE_DIR = isDev ? __dirname : app.getPath("userData");
const configPath = path.join(BASE_DIR, "config.json");
const deviceStatePath = path.join(BASE_DIR, "deviceStates.json");
const CONFIG_VERSION = 2;

const defaultInput = () => ({
  deviceId: "",
  monitorVolume: 1,
  outputVolume: 1,
  monitorMute: false,
  outputMute: false,
  forceMono: false
});

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  inputs: [defaultInput(), defaultInput(), defaultInput()],
  monitorDeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  outputMasterVolume: 1,
  eq: {
    low: 0,
    mid: 0,
    high: 0
  },
  eqCustomPresets: [],
  presets: [],
  overloadGain: 1,
};

let win;
let configCache = { ...DEFAULT_CONFIG };

function readJsonSafe(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) return fallbackValue;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallbackValue;
  }
}

function migrateConfig(rawConfig = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...rawConfig
  };

  merged.version = CONFIG_VERSION;
  merged.monitorMasterVolume = Number.isFinite(merged.monitorMasterVolume) ? merged.monitorMasterVolume : 1;
  merged.outputMasterVolume = Number.isFinite(merged.outputMasterVolume) ? merged.outputMasterVolume : 1;
  const legacyBass = Number.isFinite(merged.bassGain) ? merged.bassGain : 0;
  const rawEq = merged.eq && typeof merged.eq === "object" ? merged.eq : {};
  merged.eq = {
    low: Number.isFinite(rawEq.low) ? rawEq.low : legacyBass,
    mid: Number.isFinite(rawEq.mid) ? rawEq.mid : 0,
    high: Number.isFinite(rawEq.high) ? rawEq.high : 0
  };

  merged.eqCustomPresets = Array.isArray(merged.eqCustomPresets)
    ? merged.eqCustomPresets.filter(item => item && typeof item.name === "string" && item.values)
    : [];

  merged.presets = Array.isArray(merged.presets)
    ? merged.presets.filter(item => item && typeof item.name === "string" && item.snapshot)
    : [];
  merged.overloadGain = Number.isFinite(merged.overloadGain) ? merged.overloadGain : 1;

  const existingInputs = Array.isArray(rawConfig.inputs) ? rawConfig.inputs : [];
  merged.inputs = [0, 1, 2].map(index => {
    const input = { ...defaultInput(), ...(existingInputs[index] || {}) };
    return {
      deviceId: input.deviceId,
      monitorVolume: input.monitorVolume,
      outputVolume: input.outputVolume,
      monitorMute: !!input.monitorMute,
      outputMute: !!input.outputMute,
      forceMono: !!input.forceMono
    };
  });

  delete merged.bassGain;
  delete merged.autoGainEnabled;
  delete merged.telemetryEnabled;

  return merged;
}

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    title: `Luna's Audio Mixer v${version}`,
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: true,
      devTools: isDev
    }
  });

  win.loadFile('index.html');

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  win.once('ready-to-show', () => {
    win.show();
  });
}

ipcMain.handle("config:load", () => {
  const loaded = readJsonSafe(configPath, DEFAULT_CONFIG);
  const migrated = migrateConfig(loaded);
  configCache = migrated;
  writeConfig(migrated);
  return migrated;
});

ipcMain.on("config:save", (event, config) => {
  const migrated = migrateConfig(config);
  configCache = migrated;
  writeConfig(migrated);
});

ipcMain.handle("deviceState:load", () => {
  if (!fs.existsSync(deviceStatePath)) return {};
  return JSON.parse(fs.readFileSync(deviceStatePath));
});

ipcMain.on("deviceState:save", (event, deviceState) => {
  fs.writeFileSync(deviceStatePath, JSON.stringify(deviceState, null, 2));
});

ipcMain.handle("app:isDev", () => isDev);

if (squirrelStartup) app.quit();

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
      if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
      }
  });
app.whenReady().then(() => {
  createWindow();
});
}