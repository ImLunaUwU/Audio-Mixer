"use strict";

// DUMP: send an application's own Windows output to a "dump device" the user picked in
// Settings (a device nobody listens to), so it stops playing straight into the headphones
// while app capture (which follows the process, not the device) keeps feeding the mixer.
// The dump device is never chosen automatically.
//
// Routing is done by bin/AppRouter.exe through the per-app persisted default endpoint API
// (the same one behind Windows Settings > App volume and device preferences). Windows keeps
// that setting per app even after we exit, so every change is written to a journal first and
// undone on exit, on renderer crash, at the next start, or as soon as the app runs again.

const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { readJson, writeJson } = require("./store");

const HELPER = "AppRouter.exe";
const HELPER_TIMEOUT_MS = 8000;
const PENDING_RETRY_MS = 15000;

const exeKey = name => String(name || "").trim().toLowerCase();

function parseTasklist(stdout) {
  const byExe = new Map();
  String(stdout || "").split(/\r?\n/).forEach(line => {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) return;
    const key = exeKey(match[1]);
    if (!byExe.has(key)) byExe.set(key, []);
    byExe.get(key).push(match[2]);
  });
  return byExe;
}

// AppRouter.exe list: "<isDefault 0|1>\t<endpoint id>\t<friendly name>" per active render
// endpoint. Endpoints are identified by their Windows id; friendly names are not unique
// (Virtual Audio Cable uses "Line 1 (Virtual Audio Cable)" for both the render and the
// capture side, and two render endpoints can share a name too).
function parseDevices(stdout) {
  const seen = new Set();
  return String(stdout || "").split(/\r?\n/).map(line => {
    const [isDefault, id, ...name] = line.split("\t");
    const endpointId = String(id || "").trim();
    if (!endpointId || seen.has(endpointId)) return null;
    seen.add(endpointId);
    return { id: endpointId, name: name.join(" ").trim() || endpointId, isDefault: isDefault === "1" };
  }).filter(Boolean);
}

function defaultHelperPath(rootDir) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, HELPER) : "",
    path.join(rootDir, "bin", HELPER)
  ].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch (_) { return false; } }) || "";
}

function createNodeRunner(helperPath) {
  const options = { windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 };
  const helperError = (error, stderr) => new Error((stderr && String(stderr).trim()) || error.message);
  return {
    supported: process.platform === "win32" && !!helperPath,
    helper: args => new Promise((resolve, reject) => {
      execFile(helperPath, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) reject(helperError(error, stderr));
        else resolve(stdout);
      });
    }),
    helperSync: args => {
      try {
        return execFileSync(helperPath, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        throw helperError(error, error.stderr);
      }
    },
    processes: () => new Promise(resolve => {
      execFile("tasklist", ["/fo", "csv", "/nh"], { ...options, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? new Map() : parseTasklist(stdout)));
    }),
    processesSync: () => {
      try {
        return parseTasklist(execFileSync("tasklist", ["/fo", "csv", "/nh"], { ...options, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }));
      } catch (_) {
        return new Map();
      }
    }
  };
}

/**
 * journalPath: JSON file of apps currently dumped { [exeKey]: { exeName, previous, target } }.
 * legacyJournalPaths: older journal files (early 2.0 "Hide from Windows" used appRouting.json).
 *   Their entries are merged in so apps rerouted by an older build still get put back.
 * runner: { supported, helper(args), helperSync(args), processes(), processesSync() } (injectable for tests).
 */
function createDumpRouter({ journalPath, legacyJournalPaths = [], runner, log = console }) {
  const journal = {};
  const loadJournal = file => {
    const loaded = readJson(file, {});
    Object.entries(loaded && typeof loaded.entries === "object" ? loaded.entries : {}).forEach(([key, entry]) => {
      if (!key || !entry || typeof entry !== "object" || journal[key]) return;
      journal[key] = { exeName: String(entry.exeName || key), previous: String(entry.previous || ""), target: String(entry.target || "") };
    });
  };
  loadJournal(journalPath);
  let migratedLegacy = false;
  legacyJournalPaths.forEach(file => {
    if (!file || file === journalPath || !fs.existsSync(file)) return;
    loadJournal(file);
    migratedLegacy = true;
  });
  const appliedPids = new Map(); // exeKey -> Set(pid) set to the target during this run
  let chain = Promise.resolve();
  let retryTimer = null;
  let lastDesired = { targetId: "", items: [] };

  const saveJournal = () => {
    try {
      if (Object.keys(journal).length) writeJson(journalPath, { version: 1, entries: journal });
      else if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
    } catch (error) {
      log.error("[dumpRouting] journal write failed:", error.message);
    }
  };
  if (migratedLegacy) {
    saveJournal();
    legacyJournalPaths.forEach(file => {
      if (!file || file === journalPath) return;
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (error) { log.error("[dumpRouting] could not remove old journal:", error.message); }
    });
  }

  const serial = task => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  const schedulePendingRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!Object.keys(journal).length) return;
    retryTimer = setTimeout(() => sync(lastDesired).catch(() => {}), PENDING_RETRY_MS);
    retryTimer.unref?.();
  };

  async function restoreEntry(key, pids) {
    const entry = journal[key];
    await runner.helper(["set", entry.previous || "-", ...pids]);
    delete journal[key];
    appliedPids.delete(key);
  }

  /**
   * Make Windows routing match what the renderer wants.
   * desired: { targetId, items: [{ exeName, pid }] } for every enabled app input with DUMP on.
   * targetId is the dump device's Windows endpoint id; "" (no dump device set) means nothing
   * is dumped and earlier changes are undone.
   * Returns { dumped: [exeKey], errors: [{ exeName, message }], changed: [{ key, pids }] }
   * where `changed` lists the apps whose Windows output was moved during this call.
   */
  function sync(desired) {
    return serial(async () => {
      const targetId = typeof desired?.targetId === "string" ? desired.targetId : "";
      const items = (Array.isArray(desired?.items) ? desired.items : [])
        .map(item => ({ key: exeKey(item?.exeName), exeName: String(item?.exeName || ""), pid: String(item?.pid ?? "") }))
        .filter(item => item.key && /^\d+$/.test(item.pid));
      lastDesired = { targetId, items: items.map(({ exeName, pid }) => ({ exeName, pid })) };
      const result = { dumped: [], errors: [], changed: [] };
      if (!runner.supported) {
        if (items.length) result.errors.push({ exeName: "", message: "DUMP needs the Windows build of Audio Mixer." });
        return result;
      }
      const wanted = new Map(targetId ? items.map(item => [item.key, item]) : []);
      if (!Object.keys(journal).length && !wanted.size) return result;

      const running = await runner.processes();

      // 1. Undo routing that is no longer wanted (input removed, toggle off, source changed...).
      for (const key of Object.keys(journal)) {
        if (wanted.has(key)) continue;
        const pids = running.get(key) || [];
        if (!pids.length) continue; // app not running: restore when it comes back
        try {
          await restoreEntry(key, pids);
          result.changed.push({ key, pids });
        } catch (error) {
          result.errors.push({ exeName: journal[key]?.exeName || key, message: error.message });
        }
      }

      // 2. Apply the target to every process of each wanted app.
      for (const [key, item] of wanted) {
        const pids = running.get(key) || [item.pid];
        try {
          let entry = journal[key];
          if (!entry) {
            let previous = "";
            try { previous = String(await runner.helper(["get", item.pid])).trim(); } catch (error) {
              throw new Error(`could not read the current output (${error.message})`);
            }
            if (previous === targetId) previous = "";
            entry = journal[key] = { exeName: item.exeName, previous, target: "" };
            saveJournal(); // journal first, so a crash right after still gets undone
          }
          const applied = appliedPids.get(key) || new Set();
          const fresh = entry.target !== targetId ? pids : pids.filter(pid => !applied.has(pid));
          if (fresh.length) {
            await runner.helper(["set", targetId, ...fresh]);
            if (entry.target !== targetId) applied.clear();
            fresh.forEach(pid => applied.add(pid));
            entry.target = targetId;
            appliedPids.set(key, applied);
            result.changed.push({ key, pids: fresh });
          }
          result.dumped.push(key);
        } catch (error) {
          if (journal[key] && !journal[key].target) delete journal[key];
          result.errors.push({ exeName: item.exeName, message: error.message });
        }
      }
      saveJournal();
      schedulePendingRetry();
      return result;
    });
  }

  // Synchronous best-effort restore for quit / process exit (async work would never finish).
  function restoreAllSync() {
    clearTimeout(retryTimer);
    lastDesired = { targetId: "", items: [] };
    if (!runner.supported || !Object.keys(journal).length) return;
    const running = runner.processesSync();
    Object.keys(journal).forEach(key => {
      const pids = running.get(key) || [];
      if (!pids.length) return;
      try {
        runner.helperSync(["set", journal[key].previous || "-", ...pids]);
        delete journal[key];
        appliedPids.delete(key);
      } catch (error) {
        log.error(`[dumpRouting] restore failed for ${key}:`, error.message);
      }
    });
    saveJournal();
  }

  // Active Windows render endpoints for the dump device picker.
  async function listDevices() {
    if (!runner.supported) return [];
    return parseDevices(await runner.helper(["list"]));
  }

  return {
    isSupported: () => !!runner.supported,
    listDevices,
    sync,
    restoreAll: () => sync({ targetId: "", items: [] }),
    restoreAllSync,
    pending: () => Object.keys(journal)
  };
}

module.exports = { createDumpRouter, createNodeRunner, defaultHelperPath, parseTasklist, parseDevices, exeKey };
