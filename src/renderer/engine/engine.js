// Mixer engine client. All audio runs in the Rust engine (WASAPI capture/render, 32-bit
// float mixing, EQ, drive, soft clip, limiter, metering). This class keeps the same method
// surface the Web Audio engine had, collects the desired state and sends it to Rust.
//
//  Strip: source -> [stereo | mono sum] -> trim (dB, up to +24) -> mute/solo -> meter
//         -> send[MON 1 | MON 2 | MIX] -> bus
//  Bus:   sum -> EQ low/mid/high -> drive -> fader -> soft clipper -> limiter -> meter -> device

export const BUS_IDS = ["monitor", "monitor2", "output"];
const SILENT = -200; // Rust sends -200 for -inf

const tauri = () => window.__TAURI__;
const invoke = (cmd, args) => tauri().core.invoke(cmd, args);

function listen(event, callback) {
  let unlisten = null;
  let dead = false;
  tauri().event.listen(event, e => callback(e.payload)).then(fn => { if (dead) fn(); else unlisten = fn; });
  return () => { dead = true; unlisten?.(); };
}

const toDb = v => (typeof v === "number" && v > SILENT + 1 ? v : -Infinity);

export class MixerEngine {
  constructor({ latencyHint = "ultra", inputCount = 3 } = {}) {
    this.latencyHint = latencyHint;
    this.inputCount = inputCount;
    this.ctx = null; // truthy while running (kept for app.js checks)
    this.soloActive = false;
    this.primaryBus = null;
    this.state = {
      strips: Array.from({ length: inputCount }, () => ({ source: "", enabled: false, gainDb: 0, mute: false, solo: false, forceMono: false, sends: {} })),
      buses: Object.fromEntries(BUS_IDS.map(id => [id, { volumeDb: 0, mute: false, active: false }])),
      master: {}
    };
    this.levels = {
      inputs: Array.from({ length: inputCount }, () => [-Infinity, -Infinity]),
      buses: Object.fromEntries(BUS_IDS.map(id => [id, [-Infinity, -Infinity, 0]]))
    };
    this.levelsAt = 0;
    this.flushQueued = false;
    this.unsubscribers = [];
  }

  async init() {
    if (this.ctx) return;
    this.ctx = { running: true };
    this.unsubscribers.push(listen("meters", payload => {
      (payload?.inputs || []).forEach((pair, i) => { if (this.levels.inputs[i]) this.levels.inputs[i] = [toDb(pair[0]), toDb(pair[1])]; });
      Object.entries(payload?.buses || {}).forEach(([id, v]) => { this.levels.buses[id] = [toDb(v[0]), toDb(v[1]), Math.min(0, v[2] || 0)]; });
      this.levelsAt = performance.now();
    }));
    await invoke("engine_set_latency", { hint: this.latencyHint });
    this.flush();
  }

  async resume() {
    this.setMeters(true);
  }

  setMeters(enabled) {
    invoke("engine_set_meters", { enabled: !!enabled }).catch(() => {});
  }

  // Batch every change made in the same tick into one engine_update call.
  scheduleFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => { this.flushQueued = false; this.flush(); });
  }

  flush() {
    if (!this.ctx) return;
    invoke("engine_update", { engineState: this.state }).catch(error => console.error("[engine] update failed", error));
  }

  setBusParams(id, { volumeDb, mute, active }) {
    const bus = this.state.buses[id];
    if (!bus) return;
    Object.assign(bus, { volumeDb, mute: !!mute, active: !!active });
    this.scheduleFlush();
  }

  setMasterProcessing({ eq, driveDb, softClip, limiter }) {
    const m = this.state.master;
    if (eq) m.eq = { ...eq };
    if (Number.isFinite(driveDb)) m.driveDb = driveDb;
    if (softClip) m.softClip = { enabled: !!softClip.enabled, thresholdDb: softClip.thresholdDb };
    if (limiter) m.limiter = { enabled: !!limiter.enabled, ceilingDb: limiter.ceilingDb };
    this.scheduleFlush();
  }

  // Bind a strip to an open source ("" / null = nothing).
  setStripSource(index, sourceId) {
    const strip = this.state.strips[index];
    if (!strip) return;
    strip.source = sourceId || "";
    this.scheduleFlush();
  }

  hasSource(index) {
    return !!this.state.strips[index]?.source;
  }

  // cfg = normalized input config. Solo is resolved in Rust from all strips.
  setStripParams(index, cfg, busActive) {
    const strip = this.state.strips[index];
    if (!strip || !cfg) return;
    Object.assign(strip, {
      enabled: !!cfg.enabled,
      gainDb: cfg.gainDb,
      mute: !!cfg.mute,
      solo: !!cfg.solo,
      forceMono: !!cfg.forceMono,
      sends: Object.fromEntries(BUS_IDS.map(id => [id, { on: !!(cfg.sends[id]?.on && busActive[id]), levelDb: cfg.sends[id]?.levelDb ?? 0 }]))
    });
    this.scheduleFlush();
  }

  // deviceIds = { monitor: "endpoint id" | "", ... }. Returns { busId: Error } for failures.
  async setOutputs(deviceIds) {
    const result = await invoke("engine_set_outputs", { devices: Object.fromEntries(BUS_IDS.map(id => [id, deviceIds[id] || ""])) });
    this.primaryBus = result?.primary || null;
    return Object.fromEntries(Object.entries(result?.errors || {}).map(([id, message]) => [id, new Error(message)]));
  }

  async close() {
    if (!this.ctx) return;
    this.ctx = null;
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
    await invoke("engine_set_outputs", { devices: Object.fromEntries(BUS_IDS.map(id => [id, ""])) }).catch(() => {});
  }
}

export { listen, invoke };
