// DUMP helpers: describe the dump device the user picked in Settings and build the routing
// request for the main process. Pure module (unit-tested in Node).
//
// The dump device is never picked automatically. It is stored and matched by its Windows
// endpoint id only. Friendly names are used just to spot conflicts with the mixer's own
// devices (the browser audio API only exposes names, not Windows endpoint ids), and only
// render-to-render or render-to-capture-pair comparisons are made, because Windows reuses
// names across flows (Virtual Audio Cable calls both sides "Line 1 (Virtual Audio Cable)").
import { getCableDescriptor } from "./engine/dsp.js";

export const BUS_NAMES = { monitor: "MON 1", monitor2: "MON 2", output: "MIX" };

// Chromium labels can carry a "Default - " / "Communications - " prefix and a USB
// " (046d:0a8f)" suffix that the Windows friendly name does not have.
export function normalizeDeviceName(label) {
  return String(label || "")
    .trim()
    .replace(/^(default|communications)\s+-\s+/i, "")
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Why a render endpoint is a risky dump device. Never blocks the choice.
 * device: { id, name, isDefault } (Windows render endpoint from AppRouter.exe).
 * busLabels: { monitor, monitor2, output } labels of the mixer's output devices ("" when off).
 * inputLabels: labels of capture devices used as mixer inputs.
 * Returns [{ kind: "bus" | "input" | "default", text }].
 */
export function dumpDeviceConflicts(device, { busLabels = {}, inputLabels = [] } = {}) {
  if (!device) return [];
  const name = normalizeDeviceName(device.name);
  const cable = getCableDescriptor(device.name);
  const conflicts = [];
  Object.entries(busLabels).forEach(([busId, label]) => {
    if (label && normalizeDeviceName(label) === name) {
      conflicts.push({ kind: "bus", text: `it is your ${BUS_NAMES[busId] || "mixer output"} device, so dumped apps would still be heard there and mixed in twice` });
    }
  });
  const feeds = inputLabels.find(label => {
    if (!label) return false;
    // Same-name capture side (Virtual Audio Cable lines) or the other end of a VB-CABLE pair.
    if (normalizeDeviceName(label) === name) return true;
    const other = getCableDescriptor(label);
    return !!(cable && other && cable.familyKey === other.familyKey && cable.side !== other.side);
  });
  if (feeds) conflicts.push({ kind: "input", text: `it may feed the mixer input "${feeds}", so dumped apps would be captured twice` });
  if (device.isDefault) conflicts.push({ kind: "default", text: "it is the Windows default output, so dumped apps would still play where everything else plays" });
  return conflicts;
}

/**
 * devices: Windows render endpoints [{ id, name, isDefault }].
 * chosen: { id, name } from config.dumpDevice ("" id = not set).
 * Returns { state, id, name, level, message, conflicts } where state is
 * "unset" | "missing" | "ok" | "warn" and level is "ok" | "warn" | "error".
 */
export function resolveDumpDevice({ devices = [], chosen = {}, busLabels = {}, inputLabels = [] }) {
  const id = String(chosen?.id || "");
  if (!id) {
    return {
      state: "unset", id: "", name: "", level: "error", conflicts: [],
      message: "No dump device set. Choose one in Settings > Dump device. Until then DUMP does nothing."
    };
  }
  const device = devices.find(d => d.id === id);
  if (!device) {
    return {
      state: "missing", id: "", name: chosen.name || "", level: "error", conflicts: [],
      message: `The dump device${chosen.name ? ` "${chosen.name}"` : ""} is not connected. Dumped apps play normally until it is back, or choose another one in Settings.`
    };
  }
  const conflicts = dumpDeviceConflicts(device, { busLabels, inputLabels });
  if (conflicts.length) {
    return {
      state: "warn", id: device.id, name: device.name, level: "warn", conflicts,
      message: `Dumped apps play to ${device.name}. Warning: ${conflicts.map(c => c.text).join("; ")}.`
    };
  }
  return { state: "ok", id: device.id, name: device.name, level: "ok", conflicts, message: `Dumped apps play to ${device.name}.` };
}

/**
 * Option labels for the picker. Duplicate friendly names get a short endpoint id suffix so
 * two devices called the same thing can still be told apart.
 * Returns [{ id, label, title }].
 */
export function dumpDeviceOptions(devices = [], context = {}) {
  const counts = new Map();
  devices.forEach(d => counts.set(normalizeDeviceName(d.name), (counts.get(normalizeDeviceName(d.name)) || 0) + 1));
  return devices.map(device => {
    const tags = [];
    const conflicts = dumpDeviceConflicts(device, context);
    conflicts.forEach(c => {
      if (c.kind === "bus") tags.push("used by the mixer");
      else if (c.kind === "input") tags.push("feeds a mixer input");
      else if (c.kind === "default") tags.push("Windows default");
    });
    const dup = counts.get(normalizeDeviceName(device.name)) > 1;
    const shortId = dup ? ` [${shortEndpointId(device.id)}]` : "";
    const unique = [...new Set(tags)];
    return {
      id: device.id,
      label: `${device.name}${shortId}${unique.length ? ` (${unique.join(", ")})` : ""}`,
      title: `${device.name}\n${device.id}${conflicts.length ? `\nWarning: ${conflicts.map(c => c.text).join("; ")}` : ""}`
    };
  });
}

export function shortEndpointId(id) {
  const match = String(id || "").match(/\{([0-9a-f]{8})[0-9a-f-]*\}\s*$/i);
  return match ? match[1].toLowerCase() : String(id || "").slice(-8);
}

/**
 * inputs: config inputs; apps: [{ deviceId, pid, exeName }].
 * Returns the request for dump.sync: one item per enabled app input with DUMP on.
 */
export function buildDumpRequest({ inputs = [], apps = [], targetId = "" }) {
  const byId = new Map(apps.map(app => [app.deviceId, app]));
  const seen = new Set();
  const items = [];
  inputs.forEach(cfg => {
    if (!cfg || !cfg.dump || !cfg.enabled) return;
    const app = byId.get(cfg.deviceId);
    if (!app || !app.exeName) return;
    const key = app.exeName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ exeName: app.exeName, pid: String(app.pid) });
  });
  return { targetId: targetId || "", items };
}
