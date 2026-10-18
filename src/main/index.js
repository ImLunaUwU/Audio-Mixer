"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session, shell, screen, MessageChannelMain } = require("electron");
const path = require("path");
const { version, productName } = require("../../package.json");
const { migrateConfig, migrateDeviceStates } = require("./config");
const { readJson, createDebouncedWriter } = require("./store");
const appCapture = require("./appCapture");

if (require("electron-squirrel-startup")) app.quit();

// Audio must start without a click (the app often launches hidden at boot).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const ROOT_DIR = path.join(__dirname, "..", "..");
const isDev = !app.isPackaged;
const DATA_DIR = process.env.AUDIO_MIXER_DATA_DIR || (isDev ? ROOT_DIR : app.getPath("userData"));
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DEVICE_STATE_PATH = path.join(DATA_DIR, "deviceStates.json");

const configWriter = createDebouncedWriter(CONFIG_PATH);
const deviceStateWriter = createDebouncedWriter(DEVICE_STATE_PATH);

let config = migrateConfig(readJson(CONFIG_PATH, {}));
let win = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

function resolveIcon() {
  const candidates = [
    path.join(ROOT_DIR, "assets", "icon.ico"),
    path.join(process.resourcesPath || "", "assets", "icon.ico"),
    process.execPath
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch (_) {}
  }
  return nativeImage.createEmpty();
}

function boundsAreVisible(bounds) {
  if (!bounds || bounds.x === undefined || bounds.y === undefined) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width - 50 && bounds.x + bounds.width > a.x + 50 &&
    bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 50
  );
}

function rememberWindowBounds() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  config = migrateConfig({ ...config, window: { ...bounds, maximized } });
  configWriter.write(config);
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return createWindow(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(startHidden) {
  const saved = config.window;
  const useSaved = saved && boundsAreVisible(saved);
  win = new BrowserWindow({
    title: `${productName} v${version}`,
    width: saved?.width || 1180,
    height: saved?.height || 820,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    show: false,
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // keep audio + meters smooth while minimized
      devTools: isDev
    }
  });

  if (saved?.maximized) win.maximize();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (isDev && process.env.AUDIO_MIXER_DEVTOOLS !== "0") win.webContents.openDevTools({ mode: "detach" });

  win.once("ready-to-show", () => { if (!startHidden) win.show(); });

  const saveBounds = debounce(rememberWindowBounds, 400);
  win.on("resize", saveBounds);
  win.on("move", saveBounds);

  win.on("close", event => {
    rememberWindowBounds();
    if (isQuitting || !config.closeToTray) {
      if (!isQuitting) { isQuitting = true; app.quit(); }
      return;
    }
    event.preventDefault();
    win.hide();
  });

  const contentsId = win.webContents.id;
  // Never leak capture helpers if the renderer reloads or crashes.
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) appCapture.stopOwnedBy(contentsId);
  });
  win.webContents.on("render-process-gone", () => appCapture.stopOwnedBy(contentsId));
  win.webContents.on("destroyed", () => appCapture.stopOwnedBy(contentsId));
  return win;
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Audio Mixer", click: () => showMainWindow() },
    { label: "Mute / Unmute All Outputs", click: () => win && !win.isDestroyed() && win.webContents.send("app:command", "toggleMuteAll") },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(resolveIcon());
  tray.setToolTip(`${productName} v${version}`);
  updateTrayMenu();
  tray.on("click", () => showMainWindow());
}

// ---------------------------------------------------------------------------
// IPC (all handlers validate the sender and their arguments)
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted sender");
    return fn(event, ...args);
  });
}

function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return;
    fn(event, ...args);
  });
}

function loginItemOptions(openAtLogin) {
  return process.platform === "win32"
    ? { openAtLogin, path: process.execPath, args: ["--hidden"] }
    : { openAtLogin, openAsHidden: true };
}

function getStartOnBoot() {
  try {
    const opts = loginItemOptions(false);
    return !!app.getLoginItemSettings(process.platform === "win32" ? { path: opts.path, args: opts.args } : undefined).openAtLogin;
  } catch (_) {
    return false;
  }
}

function registerIpc() {
  handle("config:load", () => config);
  on("config:save", (_event, next) => {
    if (!next || typeof next !== "object") return;
    const preservedWindow = config.window;
    config = migrateConfig({ ...next, window: preservedWindow });
    configWriter.write(config);
  });

  handle("deviceState:load", () => migrateDeviceStates(readJson(DEVICE_STATE_PATH, {})));
  on("deviceState:save", (_event, states) => {
    if (!states || typeof states !== "object") return;
    deviceStateWriter.write(migrateDeviceStates(states));
  });

  handle("app:info", () => ({ version, isDev, platform: process.platform }));
  handle("app:getStartOnBoot", () => getStartOnBoot());
  handle("app:setStartOnBoot", (_event, enabled) => {
    try { app.setLoginItemSettings(loginItemOptions(!!enabled)); } catch (_) {}
    return getStartOnBoot();
  });
  on("app:openExternal", (_event, url) => {
    if (typeof url === "string" && /^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
  });

  handle("appAudio:isSupported", () => appCapture.isSupported());
  handle("appAudio:list", () => appCapture.listApps([process.pid, ...app.getAppMetrics().map(m => m.pid)]));
  handle("appAudio:start", (event, rawPid) => {
    const pid = String(rawPid ?? "");
    const sender = event.sender;
    // PCM goes over a dedicated MessagePort that the renderer hands to the AudioWorklet,
    // so audio never waits behind UI work on the renderer's main thread.
    const { port1, port2 } = new MessageChannelMain();
    const info = appCapture.start(pid, sender.id, {
      data: chunk => port1.postMessage(chunk),
      ended: reason => {
        try { port1.close(); } catch (_) {}
        if (!sender.isDestroyed()) sender.send("appAudio:ended", pid, reason);
      }
    });
    port1.start();
    sender.postMessage("appAudio:port", { pid }, [port2]);
    return info;
  });
  on("appAudio:stop", (_event, rawPid) => appCapture.stop(String(rawPid ?? "")));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Security hardening
// ---------------------------------------------------------------------------

function hardenSession() {
  const ses = session.defaultSession;
  const allowed = new Set(["media", "speaker-selection"]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-attach-webview", event => event.preventDefault());
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.on("before-quit", () => {
    isQuitting = true;
    appCapture.stopAll();
    configWriter.flush();
    deviceStateWriter.flush();
  });
  app.on("window-all-closed", () => {
    if (isQuitting || !config.closeToTray) app.quit();
  });
  app.on("quit", () => {
    appCapture.stopAll();
    if (tray) { tray.destroy(); tray = null; }
  });
  process.on("exit", () => appCapture.stopAll());

  app.whenReady().then(() => {
    hardenSession();
    registerIpc();
    createWindow(process.argv.includes("--hidden"));
    createTray();
    app.on("activate", () => showMainWindow());
  });
}
