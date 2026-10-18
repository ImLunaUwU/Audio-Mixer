"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`[store] Failed to read ${filePath}:`, error.message);
    // Keep a copy of the unreadable file so settings are never silently lost.
    try { fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch (_) {}
    return fallback;
  }
}

// Atomic write: write to a temp file then rename, so a crash never leaves half a file.
function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function createDebouncedWriter(filePath, delayMs = 250) {
  let timer = null;
  let pending = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const value = pending;
    pending = null;
    try { writeJson(filePath, value); } catch (error) { console.error(`[store] write failed: ${error.message}`); }
  };
  return {
    write(value) {
      pending = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush
  };
}

module.exports = { readJson, writeJson, createDebouncedWriter };
