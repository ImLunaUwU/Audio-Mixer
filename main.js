const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const squirrelStartup = require('electron-squirrel-startup');

const isDev = !app.isPackaged;
const BASE_DIR = isDev ? __dirname : app.getPath("userData");
const configPath = path.join(BASE_DIR, "config.json");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: true,
      devTools: false
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