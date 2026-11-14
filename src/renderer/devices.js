// Device + application discovery, rebinding and routing-safety rules.
import { inferChannelsFromLabel, getCableDescriptor } from "./engine/dsp.js";
import { APP_PREFIX } from "./engine/sources.js";

// Windows endpoints from the Rust engine (WASAPI). Device ids are Windows endpoint ids, so
// they are the same ids DUMP uses. Channel counts are inferred from the label like the
// Electron build did, so the multichannel filter hides the same devices.
export async function enumerateDevices({ showMultichannel }) {
  const devices = await window.mixerAPI.devices.list();
  const pick = flow => (devices || [])
    .filter(d => d.flow === flow && d.id)
    .map(d => ({
      deviceId: d.id,
      label: d.name || (flow === "capture" ? "Unnamed input" : "Unnamed output"),
      kind: flow === "capture" ? "audioinput" : "audiooutput",
      channels: inferChannelsFromLabel(d.name),
      isDefault: !!d.isDefault
    }))
    .filter(d => showMultichannel || d.channels <= 2);
  return { inputs: pick("capture"), outputs: pick("render") };
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

// Chromium (Electron build) labels can carry a "Default - " / "Communications - " prefix and
// a USB " (046d:0a8f)" suffix that the Windows friendly name does not have.
export function normalizeLabel(label) {
  return String(label || "")
    .trim()
    .replace(/^(default|communications)\s+-\s+/i, "")
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Find a stand-in for a device/app that disappeared: match by stored label. Settings saved
// by the Electron build hold Chromium device ids, so this is also how they carry over.
export function findReplacement(label, candidates, usedIds = new Set()) {
  if (!label) return "";
  const exact = candidates.find(c => c.label === label && !usedIds.has(c.deviceId));
  if (exact) return exact.deviceId;
  const wanted = normalizeLabel(label);
  const match = candidates.find(c => normalizeLabel(c.label) === wanted && !usedIds.has(c.deviceId));
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
