const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("configAPI", {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (cfg) => ipcRenderer.send("config:save", cfg)
});
contextBridge.exposeInMainWorld("deviceStateAPI", {
  loadState: () => ipcRenderer.invoke("deviceState:load"),
  saveState: (state) => ipcRenderer.send("deviceState:save", state)
});