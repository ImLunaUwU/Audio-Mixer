const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const squirrelStartup = require('electron-squirrel-startup');
const { version } = require("./package.json");

const isDev = !app.isPackaged;
const BASE_DIR = isDev ? __dirname : app.getPath("userData");
const configPath = path.join(BASE_DIR, "config.json");
const deviceStatePath = path.join(BASE_DIR, "deviceStates.json");
const CONFIG_VERSION = 3;

const defaultInput = () => ({
  deviceId: "",
  monitorVolume: 1,
  monitor2Volume: 1,
  outputVolume: 1,
  monitorMute: false,
  monitor2Mute: false,
  outputMute: false,
  forceMono: false
});

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  inputs: [defaultInput(), defaultInput(), defaultInput()],
  showMultichannelDevices: false,
  enforceRoutingSafety: true,
  monitorDeviceId: null,
  monitor2DeviceId: null,
  mixedOutputDeviceId: null,
  monitorMasterVolume: 1,
  monitor2MasterVolume: 1,
  outputMasterVolume: 1,
  eq: {
    low: 0,
    mid: 0,
    high: 0
  },
  eqCustomPresets: [],
  presets: [],
  overloadGain: 1,
  softClipEnabled: true,
  softClipThresholdDb: -6,
};

let win;
let tray;
let isQuitting = false;
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
  const normalizeVolume = (value, fallback = 1) => Number.isFinite(value) ? value : fallback;
  const normalizeInput = rawInput => {
    const input = { ...defaultInput(), ...(rawInput || {}) };
    const monitorVolume = normalizeVolume(input.monitorVolume, 1);
    return {
      deviceId: typeof input.deviceId === "string" ? input.deviceId : "",
      monitorVolume,
      monitor2Volume: normalizeVolume(input.monitor2Volume, monitorVolume),
      outputVolume: normalizeVolume(input.outputVolume, 1),
      monitorMute: !!input.monitorMute,
      monitor2Mute: typeof input.monitor2Mute === "boolean" ? input.monitor2Mute : !!input.monitorMute,
      outputMute: !!input.outputMute,
      forceMono: !!input.forceMono
    };
  };

  const normalizeSnapshot = rawSnapshot => {
    const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
    const inputs = Array.isArray(snapshot.inputs)
      ? [0, 1, 2].map(index => normalizeInput(snapshot.inputs[index]))
      : [defaultInput(), defaultInput(), defaultInput()];
    const monitorMasterVolume = Number.isFinite(snapshot.monitorMasterVolume) ? snapshot.monitorMasterVolume : 1;
    return {
      ...snapshot,
      inputs,
      monitorDeviceId: typeof snapshot.monitorDeviceId === "string" ? snapshot.monitorDeviceId : "",
      monitor2DeviceId: typeof snapshot.monitor2DeviceId === "string" ? snapshot.monitor2DeviceId : "",
      mixedOutputDeviceId: typeof snapshot.mixedOutputDeviceId === "string" ? snapshot.mixedOutputDeviceId : "",
      monitorMasterVolume,
      monitor2MasterVolume: Number.isFinite(snapshot.monitor2MasterVolume) ? snapshot.monitor2MasterVolume : monitorMasterVolume,
      outputMasterVolume: Number.isFinite(snapshot.outputMasterVolume) ? snapshot.outputMasterVolume : 1,
      overloadGain: Number.isFinite(snapshot.overloadGain) ? snapshot.overloadGain : 1,
      eq: {
        low: Number.isFinite(snapshot?.eq?.low) ? snapshot.eq.low : 0,
        mid: Number.isFinite(snapshot?.eq?.mid) ? snapshot.eq.mid : 0,
        high: Number.isFinite(snapshot?.eq?.high) ? snapshot.eq.high : 0
      }
    };
  };

  const merged = {
    ...DEFAULT_CONFIG,
    ...rawConfig
  };
  const inputVersion = Number.isFinite(rawConfig?.version) ? rawConfig.version : 0;

  merged.version = CONFIG_VERSION;
  merged.monitorMasterVolume = Number.isFinite(merged.monitorMasterVolume) ? merged.monitorMasterVolume : 1;
  merged.monitor2MasterVolume = Number.isFinite(merged.monitor2MasterVolume) ? merged.monitor2MasterVolume : merged.monitorMasterVolume;
  merged.outputMasterVolume = Number.isFinite(merged.outputMasterVolume) ? merged.outputMasterVolume : 1;
  merged.enforceRoutingSafety = typeof merged.enforceRoutingSafety === "boolean" ? merged.enforceRoutingSafety : true;
  merged.monitorDeviceId = typeof merged.monitorDeviceId === "string" ? merged.monitorDeviceId : "";
  merged.monitor2DeviceId = typeof merged.monitor2DeviceId === "string" ? merged.monitor2DeviceId : "";
  merged.mixedOutputDeviceId = typeof merged.mixedOutputDeviceId === "string" ? merged.mixedOutputDeviceId : "";
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

  if (Array.isArray(merged.presets)) {
    const validPresets = merged.presets.filter(item => item && typeof item.name === "string" && item.snapshot);
    merged.presets = inputVersion >= 3
      ? validPresets.map(item => ({
          name: item.name,
          snapshot: item.snapshot
        }))
      : validPresets.map(item => ({
          name: item.name,
          snapshot: normalizeSnapshot(item.snapshot)
        }));
  } else {
    merged.presets = [];
  }
  merged.overloadGain = Number.isFinite(merged.overloadGain) ? merged.overloadGain : 1;
  merged.softClipEnabled = typeof merged.softClipEnabled === "boolean" ? merged.softClipEnabled : true;
  merged.softClipThresholdDb = Number.isFinite(merged.softClipThresholdDb)
    ? Math.min(-0.5, Math.max(-18, merged.softClipThresholdDb))
    : -6;

  const existingInputs = Array.isArray(rawConfig.inputs) ? rawConfig.inputs : [];
  merged.inputs = [0, 1, 2].map(index => normalizeInput(existingInputs[index]));

  delete merged.bassGain;
  delete merged.autoGainEnabled;
  delete merged.telemetryEnabled;

  return merged;
}

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getWindowsLoginItemOptions(openAtLogin) {
  return {
    openAtLogin,
    path: process.execPath,
    args: ["--hidden"]
  };
}

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "assets", "icon.ico"),
    path.join(process.resourcesPath || "", "assets", "icon.ico"),
    path.join(process.resourcesPath || "", "app.asar", "assets", "icon.ico"),
    process.execPath
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch (_) {}
  }

  return nativeImage.createEmpty();
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  const trayIcon = resolveTrayIcon();
  tray = new Tray(trayIcon);
  tray.setToolTip("Luna's Audio Mixer");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Show Audio Mixer",
      click: () => showMainWindow()
    },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", () => showMainWindow());
}

function createWindow() {
  const startHidden = process.argv.includes("--hidden");
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
    if (!startHidden) {
      win.show();
    }
  });

  win.on("close", event => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
}

ipcMain.handle("config:load", () => {
  const loaded = readJsonSafe(configPath, DEFAULT_CONFIG);
  const migrated = migrateConfig(loaded);
  configCache = migrated;
  const loadedString = JSON.stringify(loaded);
  const migratedString = JSON.stringify(migrated);
  if (loadedString !== migratedString) {
    fs.writeFileSync(configPath, `${migratedString}\n`);
  }
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

ipcMain.handle("app:getStartOnBoot", () => {
  try {
    if (process.platform === "win32") {
      const winOptions = getWindowsLoginItemOptions(false);
      return !!app.getLoginItemSettings({
        path: winOptions.path,
        args: winOptions.args
      }).openAtLogin;
    }
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
});

ipcMain.handle("app:setStartOnBoot", (event, enabled) => {
  const openAtLogin = !!enabled;
  try {
    if (process.platform === "win32") {
      const winOptions = getWindowsLoginItemOptions(openAtLogin);
      app.setLoginItemSettings(winOptions);
    } else {
      app.setLoginItemSettings({
        openAtLogin,
        openAsHidden: true
      });
    }
  } catch (_) {}

  try {
    if (process.platform === "win32") {
      const winOptions = getWindowsLoginItemOptions(false);
      return !!app.getLoginItemSettings({
        path: winOptions.path,
        args: winOptions.args
      }).openAtLogin;
    }
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
});


// ---------------------------------------------------------------------------
// Per-application audio capture (Windows 10 2004+ / WASAPI process loopback)
// ---------------------------------------------------------------------------
// Uses the `application-loopback` package, which ships small native helper
// executables: ProcessList.exe (lists windows + PIDs) and ApplicationLoopback.exe
// (captures one process tree and writes raw PCM s16le, 2ch, 48 kHz to stdout).
// PCM chunks are forwarded to the renderer, which turns them into a MediaStream.
const APP_AUDIO_SUPPORTED = process.platform === "win32" && process.arch === "x64";
let appLoopback = null;
const appCaptureOwners = new Map();

function getAppLoopback() {
  if (!APP_AUDIO_SUPPORTED) return null;
  if (appLoopback) return appLoopback;
  try {
    appLoopback = require("application-loopback");
    // Executables can't be spawned from inside app.asar; point at the unpacked copy.
    const binRoot = path.join(path.dirname(require.resolve("application-loopback")), "..", "bin")
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    appLoopback.setExecutablesRoot(binRoot);
  } catch (error) {
    console.error("application-loopback unavailable:", error);
    appLoopback = null;
  }
  return appLoopback;
}

function getProcessImageNames() {
  return new Promise(resolve => {
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const names = new Map();
      if (error || !stdout) return resolve(names);
      stdout.split(/\r?\n/).forEach(line => {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match) names.set(match[2], match[1]);
      });
      resolve(names);
    });
  });
}

async function listAudioApps() {
  const loopback = getAppLoopback();
  if (!loopback) return [];
  const [windows, imageNames] = await Promise.all([
    loopback.getActiveWindowProcessIds().catch(() => []),
    getProcessImageNames()
  ]);
  const byPid = new Map();
  windows.forEach(win => {
    const pid = String(win.processId || "").trim();
    if (!pid || pid === String(process.pid) || byPid.has(pid)) return;
    const exeName = imageNames.get(pid) || "";
    byPid.set(pid, { pid, exeName, title: (win.title || "").trim() });
  });
  return [...byPid.values()].sort((a, b) => (a.exeName || a.title).localeCompare(b.exeName || b.title));
}

function stopAppCapture(pid) {
  const loopback = getAppLoopback();
  appCaptureOwners.delete(pid);
  if (!loopback) return false;
  try {
    return loopback.stopAudioCapture(pid);
  } catch (_) {
    return false;
  }
}

function stopAllAppCaptures() {
  [...appCaptureOwners.keys()].forEach(stopAppCapture);
}

ipcMain.handle("appAudio:isSupported", () => !!getAppLoopback());

ipcMain.handle("appAudio:list", () => listAudioApps());

ipcMain.handle("appAudio:start", (event, rawPid) => {
  const pid = String(rawPid || "").replace(/[^0-9]/g, "");
  const loopback = getAppLoopback();
  if (!loopback) throw new Error("Per-app audio capture is only supported on Windows 10 (2004+) x64.");
  if (!pid) throw new Error("Invalid process id.");
  stopAppCapture(pid);
  const sender = event.sender;
  appCaptureOwners.set(pid, sender);
  loopback.startAudioCapture(pid, {
    onData: chunk => {
      if (sender.isDestroyed()) {
        stopAppCapture(pid);
        return;
      }
      sender.send("appAudio:data", pid, chunk);
    }
  });
  return { pid, sampleRate: 48000, channels: 2, format: "s16le" };
});

ipcMain.on("appAudio:stop", (event, rawPid) => {
  stopAppCapture(String(rawPid || ""));
});

if (squirrelStartup) app.quit();

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopAllAppCaptures();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on("activate", () => {
      if (!win || win.isDestroyed()) {
        createWindow();
      } else {
        showMainWindow();
      }
    });
  });

  app.on("window-all-closed", event => {
    event.preventDefault();
  });

  app.on("quit", () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}