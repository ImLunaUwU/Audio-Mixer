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

app.on("browser-window-created", (_e, win) => {
  win.webContents.on("console-message", (_ev, level, message, line, source) => {
    if (level >= 2) errors++;
    console.log(`[renderer:${["log", "info", "warn", "error"][level] || level}] ${message} (${path.basename(source || "")}:${line})`);
  });
  win.webContents.on("preload-error", (_ev, p, error) => { errors++; console.log(`[preload-error] ${error}`); });
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
        stripStatus: [...document.querySelectorAll('.status-dot')].map(d => d.dataset.state + ': ' + d.title)
      })`);
      console.log("[smoke]", JSON.stringify(result));
      win.show();
      if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.log(`[smoke] errors=${errors}`);
      app.exit(errors ? 1 : 0);
    }, 4000);
  });
});

require("../src/main/index.js");
