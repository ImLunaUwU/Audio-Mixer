// Input sources: hardware capture devices (getUserMedia) and application capture
// (PCM from the main process played by the app-pcm-player worklet).

export const APP_PREFIX = "app:";
export const isAppSource = id => typeof id === "string" && id.startsWith(APP_PREFIX);
export const appPid = id => (isAppSource(id) ? id.slice(APP_PREFIX.length) : "");

export class SourceManager {
  constructor({ ctxProvider, appAudio, onEnded, onAppStats, getBufferSettings }) {
    this.ctxProvider = ctxProvider;
    this.appAudio = appAudio;
    this.onEnded = onEnded; // (sourceId, reason)
    this.onAppStats = onAppStats; // (sourceId, stats)
    this.getBufferSettings = getBufferSettings || (() => ({ targetMs: 60, minTargetMs: 30 }));
    this.devices = new Map(); // deviceId -> MediaStream
    this.apps = new Map(); // pid -> { node }
    this.pendingPorts = new Map(); // pid -> MessagePort that arrived before the node
    this.unsubscribers = [];
    // PCM MessagePorts from the main process are handed straight to the worklet.
    const onPort = event => {
      if (event.source !== window || event.data?.type !== "mixer:appAudioPort" || !event.ports[0]) return;
      this.attachPort(event.data.pid, event.ports[0]);
    };
    window.addEventListener("message", onPort);
    this.unsubscribers.push(() => window.removeEventListener("message", onPort));
    if (appAudio) {
      this.unsubscribers.push(appAudio.onEnded((pid, reason) => {
        if (!this.apps.has(pid)) return;
        this.releaseApp(pid, false);
        this.onEnded?.(`${APP_PREFIX}${pid}`, reason);
      }));
    }
  }

  // ---- hardware devices
  async openDevice(deviceId) {
    const existing = this.devices.get(deviceId);
    if (existing && existing.getAudioTracks().some(t => t.readyState === "live")) return existing;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
        latency: { ideal: 0.005 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    stream.getAudioTracks().forEach(track => {
      track.addEventListener("ended", () => {
        if (this.devices.get(deviceId) !== stream) return;
        this.devices.delete(deviceId);
        this.onEnded?.(deviceId, "device disconnected");
      });
    });
    this.devices.set(deviceId, stream);
    return stream;
  }

  releaseDevice(deviceId) {
    const stream = this.devices.get(deviceId);
    if (!stream) return;
    this.devices.delete(deviceId);
    stream.getTracks().forEach(track => track.stop());
  }

  // ---- applications
  async openApp(pid) {
    if (!this.appAudio) throw new Error("Application capture is unavailable.");
    const existing = this.apps.get(pid);
    if (existing) return existing.node;
    const ctx = this.ctxProvider();
    const node = new AudioWorkletNode(ctx, "app-pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { inputRate: 48000, ...this.getBufferSettings() }
    });
    node.port.onmessage = event => this.onAppStats?.(`${APP_PREFIX}${pid}`, event.data);
    const entry = { node };
    this.apps.set(pid, entry);
    const pending = this.pendingPorts.get(pid);
    if (pending) { this.pendingPorts.delete(pid); this.attachPort(pid, pending); }
    try {
      await this.appAudio.start(pid);
    } catch (error) {
      this.releaseApp(pid);
      throw error;
    }
    return node;
  }

  attachPort(pid, port) {
    const entry = this.apps.get(pid);
    if (!entry) {
      this.pendingPorts.get(pid)?.close();
      this.pendingPorts.set(pid, port);
      return;
    }
    entry.port?.close();
    entry.port = port;
    entry.node.port.postMessage({ type: "port", port }, [port]);
  }

  setBufferSettings(settings) {
    this.apps.forEach(entry => entry.node.port.postMessage({ type: "config", ...settings }));
  }

  releaseApp(pid, stopHelper = true) {
    const entry = this.apps.get(pid);
    if (!entry) return;
    this.apps.delete(pid);
    if (stopHelper) {
      try { this.appAudio?.stop(pid); } catch (_) {}
    }
    try { entry.node.disconnect(); } catch (_) {}
    entry.node.port.onmessage = null;
    entry.node.port.close?.();
  }

  // ---- generic
  async open(sourceId) {
    return isAppSource(sourceId)
      ? { kind: "node", node: await this.openApp(appPid(sourceId)) }
      : { kind: "stream", stream: await this.openDevice(sourceId) };
  }

  release(sourceId) {
    if (isAppSource(sourceId)) this.releaseApp(appPid(sourceId));
    else this.releaseDevice(sourceId);
  }

  releaseAllExcept(keepIds) {
    const keep = new Set(keepIds);
    [...this.devices.keys()].forEach(id => { if (!keep.has(id)) this.releaseDevice(id); });
    [...this.apps.keys()].forEach(pid => { if (!keep.has(`${APP_PREFIX}${pid}`)) this.releaseApp(pid); });
  }

  isLive(sourceId) {
    if (isAppSource(sourceId)) return this.apps.has(appPid(sourceId));
    const stream = this.devices.get(sourceId);
    return !!stream && stream.getAudioTracks().some(t => t.readyState === "live");
  }

  dispose() {
    this.releaseAllExcept([]);
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
  }
}
