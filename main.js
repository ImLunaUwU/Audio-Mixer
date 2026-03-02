const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require("electron");
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
  showMultichannelDevices: false,
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