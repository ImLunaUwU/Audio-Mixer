"use strict";

// Per-application audio capture via Windows WASAPI process loopback.
// Uses the native helper executables shipped with `application-loopback`, but spawns
// them directly so we can observe exit, forward errors and guarantee cleanup.
//   ProcessList.exe          -> "pid;hwnd;title" lines for visible top-level windows
//   ApplicationLoopback.exe  -> raw PCM s16le, 2 ch, 48 kHz on stdout for a process tree

const path = require("path");
const { spawn, execFile } = require("child_process");

const SUPPORTED = process.platform === "win32" && process.arch === "x64";
const PCM_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, format: "s16le" });

let loopback = null;
const captures = new Map(); // pid -> { child, owner }

function getLoopback() {
  if (!SUPPORTED) return null;
  if (loopback) return loopback;
  try {
    loopback = require("application-loopback");
    // Executables cannot be spawned from inside app.asar; use the unpacked copy.
    const binRoot = path
      .join(path.dirname(require.resolve("application-loopback")), "..", "bin")
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    loopback.setExecutablesRoot(binRoot);
  } catch (error) {
    console.error("[appCapture] application-loopback unavailable:", error);
    loopback = null;
  }
  return loopback;
}

function isSupported() {
  return !!getLoopback();
}

function getProcessImageNames() {
  return new Promise(resolve => {
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const names = new Map();
      if (!error && stdout) {
        stdout.split(/\r?\n/).forEach(line => {
          const match = line.match(/^"([^"]+)","(\d+)"/);
          if (match) names.set(match[2], match[1]);
        });
      }
      resolve(names);
    });
  });
}

function listWindows() {
  const lib = getLoopback();
  if (!lib) return Promise.resolve([]);
  return new Promise(resolve => {
    let output = "";
    let child;
    try {
      child = spawn(lib.getProcessListBinaryPath(), [], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (_) {
      return resolve([]);
    }
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.split(/\r?\n/).map(line => {
        const [pid, hwnd, ...titleParts] = line.split(";");
        if (!pid || !/^\d+$/.test(pid.trim())) return null;
        return { pid: pid.trim(), hwnd, title: titleParts.join(";").trim() };
      }).filter(Boolean));
    });
  });
}

async function listApps(ownPids = []) {
  if (!getLoopback()) return [];
  const [windows, names] = await Promise.all([listWindows(), getProcessImageNames()]);
  const exclude = new Set(ownPids.map(String));
  const byPid = new Map();
  windows.forEach(win => {
    if (exclude.has(win.pid) || byPid.has(win.pid)) return;
    byPid.set(win.pid, { pid: win.pid, exeName: names.get(win.pid) || "", title: win.title });
  });
  return [...byPid.values()].sort((a, b) =>
    (a.exeName || a.title).localeCompare(b.exeName || b.title, undefined, { sensitivity: "base" })
  );
}

function stop(pid) {
  const entry = captures.get(pid);
  if (!entry) return false;
  captures.delete(pid);
  entry.stopped = true;
  try { entry.child.kill(); } catch (_) {}
  return true;
}

function stopAll() {
  [...captures.keys()].forEach(stop);
}

function stopOwnedBy(webContentsId) {
  [...captures.entries()].forEach(([pid, entry]) => {
    if (entry.ownerId === webContentsId) stop(pid);
  });
}

/**
 * Start capturing `pid`. `sink` receives { data(chunk), ended(reason) }.
 */
function start(pid, ownerId, sink) {
  const lib = getLoopback();
  if (!lib) throw new Error("Per-app audio capture requires Windows 10 (2004+) x64.");
  if (!/^\d+$/.test(pid)) throw new Error("Invalid process id.");
  stop(pid);

  const child = spawn(lib.getLoopbackBinaryPath(), [pid], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const entry = { child, ownerId, stopped: false };
  captures.set(pid, entry);

  let stderr = "";
  child.stdout.on("data", chunk => {
    if (!entry.stopped) sink.data(chunk);
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-500); });
  const finish = reason => {
    if (captures.get(pid) === entry) captures.delete(pid);
    if (!entry.stopped) {
      entry.stopped = true;
      sink.ended(reason);
    }
  };
  child.on("error", error => finish(error.message));
  child.on("exit", code => finish(code === 0 ? "process exited" : `helper exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`));
  return { pid, ...PCM_FORMAT };
}

module.exports = { isSupported, listApps, start, stop, stopAll, stopOwnedBy, PCM_FORMAT };
