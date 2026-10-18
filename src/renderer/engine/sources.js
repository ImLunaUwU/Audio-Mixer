// Input sources: hardware capture devices (getUserMedia) and application capture
// (PCM from the main process played by the app-pcm-player worklet).

export const APP_PREFIX = "app:";
export const isAppSource = id => typeof id === "string" && id.startsWith(APP_PREFIX);
export const appPid = id => (isAppSource(id) ? id.slice(APP_PREFIX.length) : "");

const FRAME_BYTES = 4; // s16le stereo

export class SourceManager {
  constructor({ ctxProvider, appAudio, onEnded }) {
    this.ctxProvider = ctxProvider;
    this.appAudio = appAudio;
    this.onEnded = onEnded; // (sourceId, reason)
    this.devices = new Map(); // deviceId -> MediaStream
    this.apps = new Map(); // pid -> { node, remainder }
    this.unsubscribers = [];
    if (appAudio) {
      this.unsubscribers.push(appAudio.onData((pid, chunk) => this.handleAppData(pid, chunk)));
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
      processorOptions: { inputRate: 48000, targetLatency: 0.03, maxLatency: 0.12 }
    });
    const entry = { node, remainder: null };
    this.apps.set(pid, entry);
    try {
      await this.appAudio.start(pid);
    } catch (error) {
      this.releaseApp(pid);
      throw error;
    }
    return node;
  }

  handleAppData(pid, chunk) {
    const entry = this.apps.get(pid);
    if (!entry) return;
    let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (entry.remainder) {
      const merged = new Uint8Array(entry.remainder.length + bytes.length);
      merged.set(entry.remainder, 0);
      merged.set(bytes, entry.remainder.length);
      bytes = merged;
    }
    const usable = bytes.length - (bytes.length % FRAME_BYTES);
    entry.remainder = usable < bytes.length ? bytes.slice(usable) : null;
    if (!usable) return;
    const buffer = bytes.slice(0, usable).buffer;
    entry.node.port.postMessage(buffer, [buffer]);
  }

  releaseApp(pid, stopHelper = true) {
    const entry = this.apps.get(pid);
    if (!entry) return;
    this.apps.delete(pid);
    if (stopHelper) {
      try { this.appAudio?.stop(pid); } catch (_) {}
    }
    try { entry.node.disconnect(); } catch (_) {}
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
