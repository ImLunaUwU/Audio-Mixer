// Keyboard shortcuts. Ignored while typing in text fields or with a dialog open.
export const SHORTCUTS = [
  ["1 – 3", "Select input strip"],
  ["↑ / ↓", "Nudge selected fader ±0.5 dB (Shift: ±3 dB)"],
  ["0", "Reset selected fader to 0 dB"],
  ["M", "Mute selected input"],
  ["S", "Solo selected input"],
  ["O", "Toggle mono on selected input"],
  ["E", "Enable / disable selected input"],
  ["Shift + M", "Mute / unmute all outputs"],
  ["Ctrl + S", "Save preset"],
  ["Ctrl + 1 – 9", "Load preset 1 – 9"],
  ["Ctrl + R / F5", "Refresh devices and applications"],
  [",", "Open settings"],
  ["?", "Show this help"],
  ["Esc", "Close panel / dialog"]
];

export function initShortcuts(ctl) {
  window.addEventListener("keydown", event => {
    const target = event.target;
    const typing = target && (target.isContentEditable || (target.tagName === "INPUT" && !["range", "checkbox"].includes(target.type)) || target.tagName === "TEXTAREA");
    if (document.querySelector("dialog[open]") && event.key !== "Escape") return;
    if (event.key === "Escape") { ctl.closePanels(); return; }

    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "s") { event.preventDefault(); ctl.savePreset(); return; }
    if ((ctrl && event.key.toLowerCase() === "r") || event.key === "F5") { event.preventDefault(); ctl.refreshDevices({ notify: true }); return; }
    if (ctrl && /^[1-9]$/.test(event.key)) { event.preventDefault(); ctl.loadPresetIndex(Number(event.key) - 1); return; }
    if (typing || ctrl || event.altKey) return;
    // range inputs handle their own arrow keys
    if (target?.type === "range" && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;

    const i = ctl.state.selectedStrip;
    const key = event.key;
    if (/^[1-9]$/.test(key) && Number(key) <= ctl.inputCount) { ctl.selectStrip(Number(key) - 1, true); }
    else if (key === "ArrowUp") { event.preventDefault(); ctl.nudgeSelected(event.shiftKey ? 3 : 0.5); }
    else if (key === "ArrowDown") { event.preventDefault(); ctl.nudgeSelected(event.shiftKey ? -3 : -0.5); }
    else if (key === "0") ctl.updateInput(i, { gainDb: 0 });
    else if (key === "M") ctl.toggleMuteAll();
    else if (key === "m") ctl.updateInput(i, { mute: !ctl.getInput(i).mute });
    else if (key.toLowerCase() === "s") ctl.updateInput(i, { solo: !ctl.getInput(i).solo });
    else if (key.toLowerCase() === "o") ctl.updateInput(i, { forceMono: !ctl.getInput(i).forceMono });
    else if (key.toLowerCase() === "e") ctl.updateInput(i, { enabled: !ctl.getInput(i).enabled });
    else if (key === ",") ctl.openSettings();
    else if (key === "?") ctl.openHelp();
    else return;
  });
}
