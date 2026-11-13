// Mix presets: snapshot of inputs, buses, EQ and drive.
import { $, h } from "./dom.js";
import { toast } from "./toast.js";

export function initPresets(ctl) {
  const select = $("#presetSelect");
  const c = () => ctl.state.config;

  const render = (selected = select.value) => {
    select.replaceChildren(h("option", { value: "" }, c().presets.length ? "Presets…" : "No presets yet"),
      ...c().presets.map(p => h("option", { value: p.name }, p.name)));
    select.value = c().presets.some(p => p.name === selected) ? selected : "";
  };

  const save = () => {
    const suggested = select.value || "";
    const dialog = $("#presetDialog");
    const input = $("#presetDialogName");
    input.value = suggested;
    dialog.showModal();
    input.select();
    dialog.onclose = () => {
      if (dialog.returnValue !== "save") return;
      const name = input.value.trim().slice(0, 40);
      if (!name) return toast("Preset name can't be empty.", "error");
      const list = c().presets.filter(p => p.name.toLowerCase() !== name.toLowerCase());
      list.push({ name, snapshot: ctl.getSnapshot() });
      c().presets = list;
      ctl.save();
      render(name);
      toast(`Saved preset "${name}".`, "success");
    };
  };

  const load = async name => {
    const preset = c().presets.find(p => p.name === name);
    if (!preset) return;
    await ctl.applySnapshot(preset.snapshot);
    render(name);
    toast(`Loaded preset "${name}".`, "success");
  };

  const remove = () => {
    const name = select.value;
    if (!name) return toast("Select a preset to delete.", "error");
    if (!confirm(`Delete preset "${name}"?`)) return;
    c().presets = c().presets.filter(p => p.name !== name);
    ctl.save();
    render("");
    toast(`Deleted preset "${name}".`, "success");
  };

  // Enter in the name field should save, not trigger the first (Cancel) button.
  $("#presetDialogName").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); $("#presetDialog").close("save"); }
  });

  select.addEventListener("change", () => { if (select.value) load(select.value); });
  $("#presetSave").addEventListener("click", save);
  $("#presetDelete").addEventListener("click", remove);
  render();
  return { render, save, loadIndex: i => { const p = c().presets[i]; if (p) load(p.name); } };
}
