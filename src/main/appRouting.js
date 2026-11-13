"use strict";

// "Hide from Windows": reroute an application's own Windows output to a device nobody listens
// to, so it stops playing straight into the headphones while app capture (which follows the
// process, not the device) keeps feeding it into the mixer.
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

function parseOutputs(stdout) {
  return String(stdout || "").split(/\r?\n/).map(line => {
    const [isDefault, id, ...name] = line.split("\t");
    if (!id || !id.trim()) return null;
    return { id: id.trim(), name: name.join(" ").trim() || id.trim(), isDefault: isDefault === "1" };
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
 * journalPath: JSON file of apps currently rerouted { [exeKey]: { exeName, previous, target } }.
 * runner: { supported, helper(args), helperSync(args), processes(), processesSync() } (injectable for tests).
 */
function createAppRouter({ journalPath, runner, log = console }) {
  const loaded = readJson(journalPath, {});
  const journal = {};
  Object.entries(loaded && typeof loaded.entries === "object" ? loaded.entries : {}).forEach(([key, entry]) => {
    if (!key || !entry || typeof entry !== "object") return;
    journal[key] = { exeName: String(entry.exeName || key), previous: String(entry.previous || ""), target: String(entry.target || "") };
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
      log.error("[appRouting] journal write failed:", error.message);
    }
  };

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
   * desired: { targetId, items: [{ exeName, pid }] } for every app input with "Hide" on.
   * Returns { hidden: [exeKey], errors: [{ exeName, message }] }.
   */
  function sync(desired) {
    return serial(async () => {
      const targetId = typeof desired?.targetId === "string" ? desired.targetId : "";
      const items = (Array.isArray(desired?.items) ? desired.items : [])
        .map(item => ({ key: exeKey(item?.exeName), exeName: String(item?.exeName || ""), pid: String(item?.pid ?? "") }))
        .filter(item => item.key && /^\d+$/.test(item.pid));
      lastDesired = { targetId, items: items.map(({ exeName, pid }) => ({ exeName, pid })) };
      const result = { hidden: [], errors: [] };
      if (!runner.supported) {
        if (items.length) result.errors.push({ exeName: "", message: "Hide from Windows needs the Windows build of Audio Mixer." });
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
          }
          result.hidden.push(key);
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
        log.error(`[appRouting] restore failed for ${key}:`, error.message);
      }
    });
    saveJournal();
  }

  async function listOutputs() {
    if (!runner.supported) return [];
    return parseOutputs(await runner.helper(["list"]));
  }

  return {
    isSupported: () => !!runner.supported,
    listOutputs,
    sync,
    restoreAll: () => sync({ targetId: "", items: [] }),
    restoreAllSync,
    pending: () => Object.keys(journal)
  };
}

module.exports = { createAppRouter, createNodeRunner, defaultHelperPath, parseTasklist, parseOutputs, exeKey };
