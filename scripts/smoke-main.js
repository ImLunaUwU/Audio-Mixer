// Headless smoke test: boots the real app (with a throwaway data dir), forwards renderer
// console output, takes a screenshot and exits. Usage:
//   xvfb-run electron scripts/smoke-main.js [screenshot.png]
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AUDIO_MIXER_DATA_DIR = process.env.AUDIO_MIXER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "audio-mixer-smoke-"));
process.env.AUDIO_MIXER_DEVTOOLS = "0";
const shot = process.argv.find(arg => arg.endsWith(".png"));
let errors = 0;
const LAYOUT_PROBE = `(() => {
  const rects = [...document.querySelectorAll('.strip')].map(el => [el, el.getBoundingClientRect()]);
  const bad = [];
  rects.forEach(([a, ra], i) => rects.slice(i + 1).forEach(([b, rb]) => {
    if (ra.left < rb.right - 1 && rb.left < ra.right - 1 && ra.top < rb.bottom - 1 && rb.top < ra.bottom - 1) bad.push(a.ariaLabel + ' x ' + b.ariaLabel);
  }));
  rects.forEach(([el, r]) => [...el.children].forEach(c => {
    const cr = c.getBoundingClientRect();
    if (cr.bottom > r.bottom + 1 || cr.top < r.top - 1) bad.push(el.ariaLabel + ' child ' + c.className + ' outside');
  }));
  return { viewport: innerWidth + 'x' + innerHeight, wrapped: document.querySelector('#mixer').classList.contains('wrapped'), stripH: Math.round(rects[0][1].height), overlaps: bad };
})()`;

app.on("browser-window-created", (_e, win) => {
  win.webContents.on("console-message", (_ev, level, message, line, source) => {
    if (level >= 2) errors++;
    console.log(`[renderer:${["log", "info", "warn", "error"][level] || level}] ${message} (${path.basename(source || "")}:${line})`);
  });
  win.webContents.on("preload-error", (_ev, p, error) => { errors++; console.log(`[preload-error] ${error}`); });
  const size = (process.env.AUDIO_MIXER_SMOKE_SIZE || "").match(/^(\d+)x(\d+)$/);
  if (size) win.setContentSize(Number(size[1]), Number(size[2]));
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      if (process.env.AUDIO_MIXER_SMOKE_INTERACT) {
        // pick the first capture device on input 1, raise its gain, open settings
        await win.webContents.executeJavaScript(`(() => {
          const sel = document.querySelector('.input-strip .source-select');
          const opt = [...sel.options].find(o => o.value && !o.disabled);
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
          document.querySelector('#settingsButton').click();
        })()`);
        await new Promise(r => setTimeout(r, 2500));
      }
      const result = await win.webContents.executeJavaScript(`({
        strips: document.querySelectorAll('.input-strip').length,
        buses: document.querySelectorAll('.bus-strip').length,
        status: document.querySelector('#statusText').textContent,
        version: document.querySelector('#appVersion').textContent,
        inputOptions: [...document.querySelector('.input-strip .source-select').options].map(o => o.textContent),
        stripStatus: [...document.querySelectorAll('.status-dot')].map(d => d.dataset.state + ': ' + d.title),
        layout: ${LAYOUT_PROBE}
      })`);
      if (result.layout.overlaps.length) errors++;
      const steps = (process.env.AUDIO_MIXER_SMOKE_RESIZE || "").split(",").filter(Boolean);
      for (const step of steps) {
        const [w, hgt] = step.split("x").map(Number);
        win.setContentSize(w, hgt);
        await new Promise(r => setTimeout(r, 600));
        const probe = await win.webContents.executeJavaScript(LAYOUT_PROBE);
        if (probe.overlaps.length) errors++;
        console.log("[smoke-resize]", step, JSON.stringify(probe));
        if (shot) fs.writeFileSync(shot.replace(/\.png$/, `-resize-${step}.png`), (await win.webContents.capturePage()).toPNG());
      }
      console.log("[smoke]", JSON.stringify(result));
      win.show();
      if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.log(`[smoke] errors=${errors}`);
      app.exit(errors ? 1 : 0);
    }, 4000);
  });
});

require("../src/main/index.js");
