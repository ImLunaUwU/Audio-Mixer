// Tauri bridge: exposes the same window.mixerAPI the Electron preload did, backed by Tauri
// commands and events. Settings are normalised here with the same schema and migrations as
// the Electron build, so existing config.json / deviceStates.json files carry over.
import { migrateConfig, migrateDeviceStates } from "./config.js";

const core = () => window.__TAURI__.core;
const invoke = (cmd, args) => core().invoke(cmd, args);
const warn = context => error => console.error(`[${context}]`, error);

function subscribe(event, callback) {
  let unlisten = null;
  let dead = false;
  window.__TAURI__.event.listen(event, e => callback(e.payload)).then(fn => { if (dead) fn(); else unlisten = fn; });
  return () => { dead = true; unlisten?.(); };
}

window.mixerAPI = {
  config: {
    load: async () => migrateConfig(await invoke("config_load")),
    save: cfg => { invoke("config_save", { config: migrateConfig(cfg) }).catch(warn("config")); }
  },
  deviceStates: {
    load: async () => migrateDeviceStates(await invoke("device_states_load")),
    save: states => { invoke("device_states_save", { states: migrateDeviceStates(states) }).catch(warn("deviceStates")); }
  },
  app: {
    info: () => invoke("app_info"),
    getStartOnBoot: () => invoke("get_start_on_boot"),
    setStartOnBoot: enabled => invoke("set_start_on_boot", { enabled: !!enabled }),
    openExternal: url => { invoke("open_external", { url: String(url) }).catch(warn("openExternal")); },
    onCommand: callback => subscribe("app-command", callback)
  },
  devices: {
    list: () => invoke("audio_list_devices"),
    onChanged: callback => subscribe("devices-changed", callback),
    onOutputError: callback => subscribe("output-error", callback)
  },
  appAudio: {
    isSupported: () => invoke("apps_supported"),
    list: async () => (await invoke("apps_list")).map(app => ({ ...app, pid: String(app.pid) })),
    onRerouted: callback => subscribe("app-rerouted", payload => callback(payload?.pid))
  },
  dump: {
    isSupported: () => invoke("dump_supported"),
    listDevices: () => invoke("dump_list_devices"),
    sync: desired => invoke("dump_sync", { desired })
  }
};
