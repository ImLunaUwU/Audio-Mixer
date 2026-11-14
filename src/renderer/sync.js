// Karaoke sync helpers for the UI (the Rust engine does the actual alignment, see
// src-tauri/src/engine/sync.rs). Pure, so they are unit-tested.

export const formatMs = ms => `${ms > 0 ? "+" : ""}${Math.round(ms)}`;

// Tooltip for an input's SYNC slider.
export function syncTitle({ offsetMs = 0, delayMs = 0, auto = false } = {}) {
  const lines = [
    "SYNC: delay this input on MIX only (ms). Your monitors are never delayed.",
    `Manual offset: ${formatMs(offsetMs)} ms (double-click: 0).`,
    `Delay on MIX now: ${Math.round(delayMs)} ms${auto ? " (karaoke sync is lining this up with your mic)" : ""}.`,
    "If you sound late against the music on your stream, raise the app's SYNC; if early, lower it."
  ];
  return lines.join("\n");
}

// Per-strip sync info from the engine's "sync" event.
export function syncInfoFor(payload, index) {
  const delays = Array.isArray(payload?.mixDelayMs) ? payload.mixDelayMs : [];
  const delayMs = Number(delays[index]);
  return { auto: !!payload?.auto, delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0 };
}
