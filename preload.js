const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("configAPI", {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (cfg) => ipcRenderer.send("config:save", cfg)
});
contextBridge.exposeInMainWorld("deviceStateAPI", {
  loadState: () => ipcRenderer.invoke("deviceState:load"),
  saveState: (state) => ipcRenderer.send("deviceState:save", state)
});

contextBridge.exposeInMainWorld("appAPI", {
  isDev: () => ipcRenderer.invoke("app:isDev"),
  getStartOnBoot: () => ipcRenderer.invoke("app:getStartOnBoot"),
  setStartOnBoot: (enabled) => ipcRenderer.invoke("app:setStartOnBoot", !!enabled)
});

contextBridge.exposeInMainWorld("appAudioAPI", {
  isSupported: () => ipcRenderer.invoke("appAudio:isSupported"),
  listApps: () => ipcRenderer.invoke("appAudio:list"),
  startCapture: (pid) => ipcRenderer.invoke("appAudio:start", String(pid)),
  stopCapture: (pid) => ipcRenderer.send("appAudio:stop", String(pid)),
  onData: (callback) => {
    const listener = (event, pid, chunk) => callback(pid, chunk);
    ipcRenderer.on("appAudio:data", listener);
    return () => ipcRenderer.removeListener("appAudio:data", listener);
  }
});
