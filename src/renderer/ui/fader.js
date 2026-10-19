// Vertical dB fader with taper, wheel/keyboard nudging and double-click reset.
import { h } from "./dom.js";
import { faderPosToDb, dbToFaderPos, formatDb, MIN_DB, clamp } from "../engine/dsp.js";

const STEPS = 1000;

export function createFader({ label, valueDb, maxDb, onInput, title }) {
  let current = valueDb;
  const input = h("input", {
    class: "fader-input",
    type: "range",
    min: "0",
    max: String(STEPS),
    step: "1",
    "aria-label": label,
    title: title || `${label}: drag, scroll or use arrow keys. Double-click resets to 0 dB.`
  });
  const readout = h("output", { class: "fader-readout" });
  const scale = h("div", { class: "fader-scale", "aria-hidden": "true" },
    ...[maxDb, maxDb > 6 ? 6 : null, 0, -6, -12, -24, -40, MIN_DB]
      .filter((v, i, arr) => v !== null && v <= maxDb && arr.indexOf(v) === i)
      .map(db => {
        // CSSOM assignment (not a style attribute) keeps the strict CSP happy.
        const tick = h("span", {}, db <= MIN_DB ? "-∞" : db > 0 ? `+${db}` : String(db));
        tick.style.bottom = `${dbToFaderPos(db, maxDb) * 100}%`;
        return tick;
      })
  );

  const render = () => {
    input.value = String(Math.round(dbToFaderPos(current, maxDb) * STEPS));
    readout.textContent = formatDb(current);
    input.setAttribute("aria-valuetext", readout.textContent);
  };

  const set = (db, notify = true) => {
    const next = db <= MIN_DB ? MIN_DB : clamp(Math.round(db * 10) / 10, MIN_DB, maxDb);
    if (next === current && notify) return;
    current = next;
    render();
    if (notify) onInput?.(current);
  };

  const nudge = delta => set((current <= MIN_DB && delta > 0 ? -40 : current) + delta);

  input.addEventListener("input", () => set(faderPosToDb(Number(input.value) / STEPS, maxDb)));
  input.addEventListener("dblclick", () => set(0));
  readout.addEventListener("dblclick", () => set(0));
  input.addEventListener("wheel", event => {
    event.preventDefault();
    nudge((event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 3 : 0.5));
  }, { passive: false });
  input.addEventListener("keydown", event => {
    const step = event.shiftKey ? 3 : 0.5;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); nudge(step); }
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); nudge(-step); }
    else if (event.key === "PageUp") { event.preventDefault(); nudge(6); }
    else if (event.key === "PageDown") { event.preventDefault(); nudge(-6); }
    else if (event.key === "Home") { event.preventDefault(); set(maxDb); }
    else if (event.key === "End") { event.preventDefault(); set(MIN_DB); }
  });

  render();
  const el = h("div", { class: "fader" }, scale, input);
  return { el, readout, input, set: db => set(db, false), nudge, get value() { return current; } };
}

// Level meter: the colour gradient lives on the track; two covers from the top reveal
// it (fully lit up to RMS, dimmed up to peak), plus a peak-hold tick and a clip LED.
export function createMeter({ title = "Level meter (bright = RMS, dim = peak, line = peak hold). Click CLIP to reset." } = {}) {
  const peakCover = h("div", { class: "meter-cover peak" });
  const rmsCover = h("div", { class: "meter-cover rms" });
  const hold = h("div", { class: "meter-hold" });
  const clip = h("button", { class: "clip-led", type: "button", title: "Clip indicator. Click to reset.", "aria-label": "Clip indicator" });
  const el = h("div", { class: "meter", title }, h("div", { class: "meter-track" }, rmsCover, peakCover, hold));
  const level = db => Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));
  return {
    el,
    clip,
    render(channel) {
      peakCover.style.height = `${(1 - level(channel.peakDb)) * 100}%`;
      rmsCover.style.height = `${(1 - level(channel.rmsDb)) * 100}%`;
      hold.style.bottom = `${level(channel.holdDb) * 100}%`;
      hold.style.opacity = channel.holdDb > MIN_DB + 1 ? "0.85" : "0";
      clip.classList.toggle("on", channel.clipped);
    }
  };
}
