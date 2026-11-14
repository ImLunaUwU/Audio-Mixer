// Settings drawer: master processing, engine, devices and app behaviour.
import { $, h } from "./dom.js";
import { formatDb } from "../engine/dsp.js";
import { toast } from "./toast.js";

export const BUILTIN_EQ_PRESETS = {
  flat: { name: "Flat", values: { low: 0, mid: 0, high: 0 } },
  voice: { name: "Voice", values: { low: -2, mid: 3.5, high: 1.5 } },
  broadcast: { name: "Broadcast", values: { low: 2.5, mid: 2, high: -1 } },
  bright: { name: "Bright", values: { low: -1.5, mid: 1, high: 3.5 } },
  bassheavy: { name: "Bass Heavy", values: { low: 5, mid: -2, high: -1 } }
};

function bindRange(id, { get, set, format }) {
  const input = $(`#${id}`);
  const out = $(`#${id}Value`);
  const render = () => {
    input.value = String(get());
    if (out) out.textContent = format(get());
  };
  input.addEventListener("input", () => {
    set(Number(input.value));
    if (out) out.textContent = format(Number(input.value));
  });
  input.addEventListener("dblclick", () => {
    const def = Number(input.dataset.default ?? 0);
    input.value = String(def);
    input.dispatchEvent(new Event("input"));
  });
  return render;
}

function bindCheckbox(id, { get, set }) {
  const input = $(`#${id}`);
  input.addEventListener("change", () => set(input.checked));
  return () => { input.checked = !!get(); };
}

export function initSettings(ctl) {
  const c = () => ctl.state.config;
  const renders = [];
  const masterChanged = () => { ctl.applyMasterProcessing(); ctl.save(); };

  ["low", "mid", "high"].forEach(band => {
    renders.push(bindRange(`eq${band[0].toUpperCase()}${band.slice(1)}`, {
      get: () => c().eq[band],
      set: v => { c().eq[band] = v; $("#eqPreset").value = ""; masterChanged(); },
      format: v => formatDb(v)
    }));
  });
  renders.push(bindRange("drive", { get: () => c().driveDb, set: v => { c().driveDb = v; masterChanged(); }, format: v => formatDb(v) }));
  renders.push(bindCheckbox("softClipEnabled", { get: () => c().softClip.enabled, set: v => { c().softClip.enabled = v; masterChanged(); renderAll(); } }));
  renders.push(bindRange("softClipThreshold", { get: () => c().softClip.thresholdDb, set: v => { c().softClip.thresholdDb = v; masterChanged(); }, format: v => formatDb(v, { unit: " dBFS" }) }));
  renders.push(bindCheckbox("limiterEnabled", { get: () => c().limiter.enabled, set: v => { c().limiter.enabled = v; masterChanged(); renderAll(); } }));
  renders.push(bindRange("limiterCeiling", { get: () => c().limiter.ceilingDb, set: v => { c().limiter.ceilingDb = v; masterChanged(); }, format: v => formatDb(v, { unit: " dBFS" }) }));

  renders.push(bindCheckbox("showMultichannel", { get: () => c().showMultichannelDevices, set: v => { c().showMultichannelDevices = v; ctl.save(); ctl.refreshDevices({ notify: false }); } }));
  renders.push(bindCheckbox("routingSafety", { get: () => c().enforceRoutingSafety, set: v => { c().enforceRoutingSafety = v; ctl.save(); ctl.renderAll(); } }));
  renders.push(bindCheckbox("compactMode", { get: () => c().compactMode, set: v => { c().compactMode = v; ctl.save(); ctl.applyLayout(); } }));
  renders.push(bindCheckbox("autoSync", { get: () => c().autoSync, set: v => ctl.setAutoSync(v) }));
  renders.push(bindCheckbox("closeToTray", { get: () => c().closeToTray, set: v => { c().closeToTray = v; ctl.save(); } }));

  const latency = $("#latencyHint");
  latency.addEventListener("change", async () => {
    c().latencyHint = latency.value;
    ctl.save();
    await ctl.restartEngine();
    toast(`Latency / Stability: ${latency.options[latency.selectedIndex].text}. Audio engine restarted.`, "success");
  });
  renders.push(() => { latency.value = c().latencyHint; });

  const startOnBoot = $("#startOnBoot");
  startOnBoot.addEventListener("change", async () => {
    startOnBoot.checked = await window.mixerAPI.app.setStartOnBoot(startOnBoot.checked);
  });
  window.mixerAPI.app.getStartOnBoot().then(v => { startOnBoot.checked = !!v; }).catch(() => {});

  // EQ presets
  const eqPreset = $("#eqPreset");
  const eqName = $("#eqPresetName");
  const renderEqPresets = () => {
    const current = eqPreset.value;
    eqPreset.replaceChildren(
      h("option", { value: "" }, "Custom…"),
      h("optgroup", { label: "Built-in" }, ...Object.entries(BUILTIN_EQ_PRESETS).map(([key, p]) => h("option", { value: `builtin:${key}` }, p.name))),
      ...(c().eqCustomPresets.length ? [h("optgroup", { label: "Saved" }, ...c().eqCustomPresets.map(p => h("option", { value: `custom:${p.name}` }, p.name)))] : [])
    );
    eqPreset.value = [...eqPreset.options].some(o => o.value === current) ? current : "";
  };
  eqPreset.addEventListener("change", () => {
    const [kind, key] = eqPreset.value.split(/:(.*)/s);
    const values = kind === "builtin" ? BUILTIN_EQ_PRESETS[key]?.values : c().eqCustomPresets.find(p => p.name === key)?.values;
    if (!values) return;
    c().eq = { ...values };
    if (kind === "custom") eqName.value = key;
    masterChanged();
    renders.forEach(fn => fn());
  });
  $("#eqPresetSave").addEventListener("click", () => {
    const name = eqName.value.trim();
    if (!name) return toast("Enter a name for the EQ preset.", "error");
    const list = c().eqCustomPresets.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, values: { ...c().eq } });
    c().eqCustomPresets = list;
    ctl.save();
    renderEqPresets();
    eqPreset.value = `custom:${name}`;
    toast(`Saved EQ preset "${name}".`, "success");
  });
  $("#eqPresetDelete").addEventListener("click", () => {
    if (!eqPreset.value.startsWith("custom:")) return toast("Select a saved EQ preset to delete.", "error");
    const name = eqPreset.value.slice(7);
    c().eqCustomPresets = c().eqCustomPresets.filter(p => p.name !== name);
    ctl.save();
    eqPreset.value = "";
    renderEqPresets();
    toast(`Deleted EQ preset "${name}".`, "success");
  });

  $("#resetMaster").addEventListener("click", () => {
    Object.assign(c(), { eq: { low: 0, mid: 0, high: 0 }, driveDb: 0, softClip: { enabled: true, thresholdDb: -6 }, limiter: { enabled: true, ceilingDb: -1 } });
    masterChanged();
    renderAll();
  });

  // Dump device: where DUMP sends an app's Windows output. Windows render endpoints from
  // AppRouter.exe, matched by endpoint id. Never picked automatically.
  const dumpSelect = $("#dumpDevice");
  const dumpStatus = $("#dumpDeviceStatus");
  dumpSelect.addEventListener("change", () => ctl.setDumpDevice(dumpSelect.value));
  $("#dumpDeviceRefresh").addEventListener("click", () => ctl.refreshDumpDevices());
  let dumpOptionsKey = "";
  function renderDump() {
    const d = ctl.state.dump;
    const chosen = c().dumpDevice;
    const options = [h("option", { value: "" }, "Not set")];
    (d.options || []).forEach(opt => options.push(h("option", { value: opt.id, title: opt.title }, opt.label)));
    if (chosen.id && !d.devices.some(dev => dev.id === chosen.id)) {
      options.push(h("option", { value: chosen.id, disabled: true }, `${chosen.name || "Saved device"} (not connected)`));
    }
    const key = JSON.stringify([chosen.id, ...options.map(o => [o.value, o.textContent])]);
    if (key !== dumpOptionsKey && (document.activeElement !== dumpSelect || !dumpSelect.options.length)) {
      dumpOptionsKey = key;
      dumpSelect.replaceChildren(...options);
      dumpSelect.value = chosen.id || "";
    }
    dumpSelect.disabled = !d.supported;
    const target = d.target;
    let level;
    let text;
    if (!d.supported) { level = "warn"; text = "Only available in the Windows app."; }
    else if (!d.loaded || !target) { level = "ok"; text = "Checking playback devices..."; }
    else { level = target.level; text = target.message; }
    dumpStatus.dataset.level = level;
    dumpStatus.textContent = text;
  }

  function renderAll() {
    renders.forEach(fn => fn());
    renderDump();
    $("#softClipThreshold").disabled = !c().softClip.enabled;
    $("#limiterCeiling").disabled = !c().limiter.enabled;
    renderEqPresets();
  }
  renderAll();
  return { render: renderAll, renderDump };
}
