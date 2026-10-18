// Channel strips (inputs) and bus strips (outputs).
import { h, toggleButton } from "./dom.js";
import { createFader, createMeter } from "./fader.js";
import { formatDb, MIN_DB } from "../engine/dsp.js";

export const BUS_LABELS = {
  monitor: { short: "MON 1", name: "Monitor 1", title: "Monitor 1 bus: usually your headphones" },
  monitor2: { short: "MON 2", name: "Monitor 2", title: "Monitor 2 bus: a second listener or speakers" },
  output: { short: "MIX", name: "Mixed Output", title: "Mixed output bus: e.g. a virtual cable for streaming or calls" }
};

function fillSelect(select, { value, groups, emptyLabel, disabled = new Map(), missingLabel }) {
  select.replaceChildren(h("option", { value: "" }, emptyLabel));
  let found = !value;
  groups.forEach(({ label, items }) => {
    if (!items.length) return;
    const group = h("optgroup", { label });
    items.forEach(item => {
      const reason = item.deviceId !== value ? disabled.get(item.deviceId) : null;
      if (item.deviceId === value) found = true;
      group.append(h("option", {
        value: item.deviceId,
        disabled: !!reason,
        title: reason || item.title || item.label
      }, reason ? `${item.label} (${reason.toLowerCase()})` : item.label));
    });
    select.append(group);
  });
  if (!found) select.append(h("option", { value, disabled: true }, missingLabel || "Unavailable source"));
  select.value = value || "";
}

export function createInputStrip(index, ctl) {
  const cfg = () => ctl.getInput(index);
  const sourceSelect = h("select", { class: "source-select", "aria-label": `Input ${index + 1} source`, title: "Pick a capture device or a running application" });
  sourceSelect.addEventListener("change", () => ctl.setInputSource(index, sourceSelect.value));

  const statusDot = h("span", { class: "status-dot", title: "Idle" });
  const power = toggleButton("⏻", { className: "power", title: "Enable / disable this input", onToggle: on => ctl.updateInput(index, { enabled: on }) });
  const mute = toggleButton("M", { className: "mute", title: "Mute (M)", onToggle: on => ctl.updateInput(index, { mute: on }) });
  const solo = toggleButton("S", { className: "solo", title: "Solo (S): only soloed inputs are heard", onToggle: on => ctl.updateInput(index, { solo: on }) });
  const mono = toggleButton("MONO", { className: "mono", title: "Sum to mono (O)", onToggle: on => ctl.updateInput(index, { forceMono: on }) });

  const sendRows = {};
  const sends = h("div", { class: "sends" }, ...Object.entries(BUS_LABELS).map(([busId, meta]) => {
    const btn = toggleButton(meta.short, {
      className: "send-toggle",
      title: `Send this input to ${meta.name}`,
      onToggle: on => ctl.updateSend(index, busId, { on })
    });
    const level = h("input", { type: "range", class: "send-level", min: String(MIN_DB), max: "0", step: "0.5", "aria-label": `${meta.name} send level`, title: `${meta.name} send level (double-click: 0 dB)` });
    const value = h("span", { class: "send-value" });
    level.addEventListener("input", () => {
      const db = Number(level.value);
      value.textContent = formatDb(db, { unit: "" });
      ctl.updateSend(index, busId, { levelDb: db });
    });
    level.addEventListener("dblclick", () => { level.value = "0"; level.dispatchEvent(new Event("input")); });
    sendRows[busId] = { btn, level, value };
    return h("div", { class: "send-row" }, btn, level, value);
  }));

  const meter = createMeter();
  const fader = createFader({
    label: `Input ${index + 1} gain`,
    valueDb: 0,
    maxDb: 24,
    title: "Input gain (up to +24 dB). Drag, scroll (Shift = coarse) or arrow keys. Double-click resets to 0 dB.",
    onInput: db => ctl.updateInput(index, { gainDb: db })
  });
  meter.clip.addEventListener("click", () => ctl.clearClip(`input:${index}`));

  const title = h("div", { class: "strip-title" }, h("span", { class: "strip-index" }, String(index + 1)), statusDot, h("span", { class: "strip-name" }, `Input ${index + 1}`));
  const el = h("section", { class: "strip input-strip", tabindex: "-1", "aria-label": `Input ${index + 1}` },
    h("header", { class: "strip-header" }, title, power),
    sourceSelect,
    sends,
    h("div", { class: "strip-buttons" }, mute, solo, mono),
    h("div", { class: "strip-body" }, fader.el, meter.el),
    h("footer", { class: "strip-footer" }, fader.readout, meter.clip)
  );
  el.addEventListener("pointerdown", () => ctl.selectStrip(index));
  el.addEventListener("focusin", () => ctl.selectStrip(index));

  return {
    el,
    fader,
    update({ devices, apps, appsSupported, disabled, status, label, selected }) {
      const c = cfg();
      fillSelect(sourceSelect, {
        value: c.deviceId,
        emptyLabel: "(No source)",
        disabled,
        missingLabel: c.label ? `${c.label} (waiting…)` : "Unavailable source",
        groups: [
          { label: "Capture devices", items: devices },
          { label: appsSupported ? "Applications" : "Applications (Windows 10 2004+ only)", items: apps }
        ]
      });
      el.querySelector(".strip-name").textContent = label || `Input ${index + 1}`;
      el.querySelector(".strip-name").title = label || "";
      power.setPressed(c.enabled);
      mute.setPressed(c.mute);
      solo.setPressed(c.solo);
      mono.setPressed(c.forceMono);
      fader.set(c.gainDb);
      Object.entries(sendRows).forEach(([busId, row]) => {
        const send = c.sends[busId];
        row.btn.setPressed(send.on);
        row.level.value = String(send.levelDb);
        row.value.textContent = formatDb(send.levelDb, { unit: "" });
      });
      el.classList.toggle("disabled", !c.enabled);
      el.classList.toggle("empty", !c.deviceId);
      el.classList.toggle("selected", !!selected);
      statusDot.dataset.state = status.state;
      statusDot.title = status.message;
    },
    renderMeter(channel) { meter.render(channel); },
    setStatusTitle(message) { statusDot.title = message; }
  };
}

export function createBusStrip(busId, ctl) {
  const meta = BUS_LABELS[busId];
  const deviceSelect = h("select", { class: "source-select", "aria-label": `${meta.name} output device`, title: meta.title });
  deviceSelect.addEventListener("change", () => ctl.setBusDevice(busId, deviceSelect.value));
  const mute = toggleButton("M", { className: "mute", title: `Mute ${meta.name}`, onToggle: on => ctl.updateBus(busId, { mute: on }) });
  const gr = h("span", { class: "gr-readout", title: "Limiter gain reduction" }, "GR 0.0");
  const meter = createMeter();
  meter.clip.addEventListener("click", () => ctl.clearClip(`bus:${busId}`));
  const fader = createFader({
    label: `${meta.name} volume`,
    valueDb: 0,
    maxDb: 12,
    onInput: db => ctl.updateBus(busId, { volumeDb: db })
  });
  const el = h("section", { class: `strip bus-strip bus-${busId}`, "aria-label": meta.name },
    h("header", { class: "strip-header" }, h("div", { class: "strip-title" }, h("span", { class: "strip-index bus" }, meta.short), h("span", { class: "strip-name" }, meta.name))),
    deviceSelect,
    h("div", { class: "strip-buttons" }, mute, gr),
    h("div", { class: "strip-body" }, fader.el, meter.el),
    h("footer", { class: "strip-footer" }, fader.readout, meter.clip)
  );
  return {
    el,
    fader,
    update({ outputs, disabled, bus }) {
      fillSelect(deviceSelect, {
        value: bus.deviceId,
        emptyLabel: "(Off)",
        disabled,
        missingLabel: "Disconnected device",
        groups: [{ label: "Output devices", items: outputs }]
      });
      mute.setPressed(bus.mute);
      fader.set(bus.volumeDb);
      el.classList.toggle("off", !bus.deviceId);
    },
    renderMeter(channel, grDb) {
      meter.render(channel);
      const g = Math.min(0, grDb || 0);
      gr.textContent = `GR ${g.toFixed(1)}`;
      gr.classList.toggle("active", g < -0.5);
    }
  };
}
