// "Hide from Windows" helpers: choose the silent device that hidden apps are sent to and
// build the routing request for the main process. Pure module (unit-tested in Node).
import { getCableDescriptor } from "./engine/dsp.js";

const VIRTUAL_RE = /\b(cable|virtual|vb-audio|vac)\b|\bline \d+\b/i;
const NOT_SILENT_RE = /voicemeeter/i; // Voicemeeter inputs usually end up in someone's ears

const norm = label => String(label || "").trim().toLowerCase();
const familyOf = label => getCableDescriptor(label)?.familyKey || "";

/**
 * outputs: [{ id, name, isDefault }] from AppRouter.exe (Windows endpoint ids).
 * busLabels: { monitor, monitor2, output } labels of the mixer's output devices.
 * inputLabels: labels of capture devices used as mixer inputs.
 * chosenId: "" for automatic, otherwise a Windows endpoint id.
 * Returns { id, name, auto, warning, level } where level is "ok" | "warn" | "error".
 */
export function resolveRouteTarget({ outputs = [], busLabels = {}, inputLabels = [], chosenId = "" }) {
  const used = new Map();
  Object.entries(busLabels).forEach(([busId, label]) => { if (label) used.set(norm(label), busId); });
  const usedFamilies = new Set([...Object.values(busLabels), ...inputLabels].map(familyOf).filter(Boolean));
  const usedInputs = new Set(inputLabels.map(norm).filter(Boolean));
  const busName = { monitor: "Monitor 1", monitor2: "Monitor 2", output: "Mixed Output" };

  const conflict = device => {
    const busId = used.get(norm(device.name));
    if (busId) return `${device.name} is your ${busName[busId] || "mixer output"} device, so hidden apps would still be heard (or mixed twice).`;
    if (usedInputs.has(norm(device.name)) || (familyOf(device.name) && usedFamilies.has(familyOf(device.name)))) {
      return `${device.name} feeds a mixer input, so hidden apps would be captured twice.`;
    }
    if (device.isDefault) return `${device.name} is the Windows default output, so hidden apps would still play there.`;
    return "";
  };

  if (chosenId) {
    const device = outputs.find(d => d.id === chosenId);
    if (!device) return { id: "", name: "", auto: false, level: "error", warning: "The device picked for hidden apps is not connected. Hidden apps play normally until it is back." };
    const warning = conflict(device);
    return { id: device.id, name: device.name, auto: false, level: warning ? "warn" : "ok", warning };
  }

  const candidate = outputs.find(d => VIRTUAL_RE.test(d.name) && !NOT_SILENT_RE.test(d.name) && !conflict(d));
  if (!candidate) {
    return {
      id: "", name: "", auto: true, level: "error",
      warning: "No unused output device found. Install a spare virtual cable or pick a device you don't listen to below. Until then hidden apps play normally."
    };
  }
  return { id: candidate.id, name: candidate.name, auto: true, level: "ok", warning: "" };
}

/**
 * inputs: config inputs; apps: [{ deviceId, pid, exeName }].
 * Returns the request for appRouting.sync: one item per enabled app input with Hide on.
 */
export function buildRoutingRequest({ inputs = [], apps = [], targetId = "" }) {
  const byId = new Map(apps.map(app => [app.deviceId, app]));
  const seen = new Set();
  const items = [];
  inputs.forEach(cfg => {
    if (!cfg || !cfg.hideFromWindows || !cfg.enabled) return;
    const app = byId.get(cfg.deviceId);
    if (!app || !app.exeName) return;
    const key = app.exeName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ exeName: app.exeName, pid: String(app.pid) });
  });
  return { targetId: targetId || "", items };
}
