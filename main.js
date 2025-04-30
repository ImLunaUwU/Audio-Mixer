const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const squirrelStartup = require('electron-squirrel-startup');
const { version } = require("./package.json");

const isDev = !app.isPackaged;
const BASE_DIR = isDev ? __dirname : app.getPath("userData");
const configPath = path.join(BASE_DIR, "config.json");
const deviceStatePath = path.join(BASE_DIR, "deviceStates.json");

let win;

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

  win.once('ready-to-show', () => {
    win.show();
  });
}

ipcMain.handle("config:load", () => {
  if (!fs.existsSync(configPath)) return {
    inputs: [],
    monitorDeviceId: null,
    mixedOutputDeviceId: null
  };
  return JSON.parse(fs.readFileSync(configPath));
});

ipcMain.on("config:save", (event, config) => {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
});

ipcMain.handle("deviceState:load", () => {
  if (!fs.existsSync(deviceStatePath)) return {};
  return JSON.parse(fs.readFileSync(deviceStatePath));
});

ipcMain.on("deviceState:save", (event, deviceState) => {
  fs.writeFileSync(deviceStatePath, JSON.stringify(deviceState, null, 2));
});

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
app.whenReady().then(createWindow);
}