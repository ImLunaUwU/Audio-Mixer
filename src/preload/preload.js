"use strict";

// Sandboxed preload: exposes a minimal, typed API. No Node primitives leak to the page.
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("mixerAPI", {
  config: {
    load: () => ipcRenderer.invoke("config:load"),
    save: cfg => ipcRenderer.send("config:save", cfg)
  },
  deviceStates: {
    load: () => ipcRenderer.invoke("deviceState:load"),
    save: states => ipcRenderer.send("deviceState:save", states)
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    getStartOnBoot: () => ipcRenderer.invoke("app:getStartOnBoot"),
    setStartOnBoot: enabled => ipcRenderer.invoke("app:setStartOnBoot", !!enabled),
    openExternal: url => ipcRenderer.send("app:openExternal", String(url)),
    onCommand: callback => subscribe("app:command", callback)
  },
  appAudio: {
    isSupported: () => ipcRenderer.invoke("appAudio:isSupported"),
    list: () => ipcRenderer.invoke("appAudio:list"),
    start: pid => ipcRenderer.invoke("appAudio:start", String(pid)),
    stop: pid => ipcRenderer.send("appAudio:stop", String(pid)),
    onData: callback => subscribe("appAudio:data", callback),
    onEnded: callback => subscribe("appAudio:ended", callback)
  }
});
