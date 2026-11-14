// Input sources: capture devices and applications, captured in Rust (WASAPI capture and
// process loopback). This keeps track of which sources are open and forwards their events.
import { listen, invoke } from "./engine.js";

export const APP_PREFIX = "app:";
export const isAppSource = id => typeof id === "string" && id.startsWith(APP_PREFIX);
export const appPid = id => (isAppSource(id) ? id.slice(APP_PREFIX.length) : "");

export class SourceManager {
  constructor({ onEnded, onAppStats } = {}) {
    this.onEnded = onEnded; // (sourceId, reason)
    this.onAppStats = onAppStats; // (sourceId, stats)
    this.live = new Set();
    this.unsubscribers = [
      listen("source-ended", ({ sourceId, reason } = {}) => {
        if (!this.live.has(sourceId)) return;
        this.live.delete(sourceId);
        this.onEnded?.(sourceId, reason || "ended");
      }),
      listen("source-stats", stats => { if (stats?.sourceId && this.live.has(stats.sourceId)) this.onAppStats?.(stats.sourceId, stats); })
    ];
  }

  async open(sourceId) {
    await invoke("engine_open_source", { sourceId });
    this.live.add(sourceId);
    return { kind: "source", id: sourceId };
  }

  release(sourceId) {
    if (!this.live.delete(sourceId)) return;
    invoke("engine_release_source", { sourceId }).catch(() => {});
  }

  releaseAllExcept(keepIds) {
    const keep = new Set(keepIds);
    [...this.live].forEach(id => { if (!keep.has(id)) this.release(id); });
  }

  isLive(sourceId) {
    return this.live.has(sourceId);
  }

  dispose() {
    this.releaseAllExcept([]);
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
  }
}
