// Device + application discovery, rebinding and routing-safety rules.
import { inferChannelsFromLabel, getCableDescriptor } from "./engine/dsp.js";
import { APP_PREFIX } from "./engine/sources.js";

const RESERVED = new Set(["default", "communications"]);

export async function enumerateDevices({ showMultichannel }) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const pick = kind => devices
    .filter(d => d.kind === kind && !RESERVED.has(d.deviceId) && d.deviceId)
    .map(d => ({ deviceId: d.deviceId, label: d.label || (kind === "audioinput" ? "Unnamed input" : "Unnamed output"), kind, channels: inferChannelsFromLabel(d.label) }))
    .filter(d => showMultichannel || d.channels <= 2);
  return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
}

export async function listApps(appAudio) {
  if (!appAudio) return { supported: false, apps: [] };
  try {
    const supported = !!(await appAudio.isSupported());
    if (!supported) return { supported, apps: [] };
    const apps = await appAudio.list();
    return {
      supported,
      apps: (Array.isArray(apps) ? apps : []).map(app => ({
        deviceId: `${APP_PREFIX}${app.pid}`,
        kind: "app",
        pid: String(app.pid),
        exeName: app.exeName || "",
        title: app.title || "",
        label: `${appDisplayName(app)}`
      }))
    };
  } catch (error) {
    console.warn("Application list failed", error);
    return { supported: true, apps: [] };
  }
}

export function appDisplayName(app) {
  const exe = (app.exeName || "").replace(/\.exe$/i, "");
  return exe || app.title || `PID ${app.pid}`;
}

// Find a stand-in for a device/app that disappeared: match by stored label.
export function findReplacement(label, candidates, usedIds = new Set()) {
  if (!label) return "";
  const match = candidates.find(c => c.label === label && !usedIds.has(c.deviceId));
  return match ? match.deviceId : "";
}

/**
 * Routing safety: no duplicate inputs, no duplicate outputs, and no virtual-cable
 * loops (e.g. "CABLE Output" as input while "CABLE Input" is an output).
 * Returns { inputs: Map[] , buses: {id: Map} } of optionId -> reason.
 */
export function computeDisabledOptions({ inputIds, busDeviceIds, inputsById, outputsById, enabled }) {
  const inputs = inputIds.map(() => new Map());
  const buses = Object.fromEntries(Object.keys(busDeviceIds).map(id => [id, new Map()]));
  if (!enabled) return { inputs, buses };

  inputIds.forEach((id, i) => {
    if (!id) return;
    inputs.forEach((map, j) => { if (j !== i) map.set(id, "Already used by another input"); });
  });
  Object.entries(busDeviceIds).forEach(([busId, id]) => {
    if (!id) return;
    Object.entries(buses).forEach(([otherId, map]) => { if (otherId !== busId) map.set(id, "Already used by another output"); });
  });

  const opposite = side => (side === "input" ? "output" : "input");
  const selectedInputCables = inputIds.map(id => inputsById.get(id)).filter(Boolean)
    .map(d => ({ ...getCableDescriptor(d.label), label: d.label })).filter(d => d.familyKey);
  const selectedOutputCables = Object.values(busDeviceIds).map(id => outputsById.get(id)).filter(Boolean)
    .map(d => ({ ...getCableDescriptor(d.label), label: d.label })).filter(d => d.familyKey);

  outputsById.forEach(device => {
    const desc = getCableDescriptor(device.label);
    if (!desc) return;
    const conflict = selectedInputCables.find(c => c.familyKey === desc.familyKey && c.side === opposite(desc.side));
    if (conflict) Object.values(buses).forEach(map => map.set(device.deviceId, `Would loop back into ${conflict.label}`));
  });
  inputsById.forEach(device => {
    const desc = getCableDescriptor(device.label);
    if (!desc) return;
    const conflict = selectedOutputCables.find(c => c.familyKey === desc.familyKey && c.side === opposite(desc.side));
    if (conflict) inputs.forEach(map => map.set(device.deviceId, `Would loop back from ${conflict.label}`));
  });
  return { inputs, buses };
}
