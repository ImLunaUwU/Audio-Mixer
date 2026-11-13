// Pure DSP helpers (no DOM / Web Audio objects) so they can be unit-tested in Node.

export const MIN_DB = -60;
export const SILENT_DB = -Infinity;
export const CLIP_DB = -0.1;

export function dbToGain(db) {
  if (!Number.isFinite(db) || db <= MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain) {
  if (!(gain > 0)) return SILENT_DB;
  return 20 * Math.log10(gain);
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// --- Fader taper -----------------------------------------------------------
// Slider position 0..1 <-> dB. Unity (0 dB) sits at UNITY_POS; below it the taper is
// quadratic (fine resolution near 0 dB), above it linear up to maxDb.
export const UNITY_POS = 0.75;

export function faderPosToDb(pos, maxDb) {
  const p = clamp(pos, 0, 1);
  if (p <= 0.001) return MIN_DB;
  if (maxDb <= 0 || p <= UNITY_POS) {
    const norm = maxDb <= 0 ? p : p / UNITY_POS;
    return MIN_DB * Math.pow(1 - norm, 2);
  }
  return maxDb * (p - UNITY_POS) / (1 - UNITY_POS);
}

export function dbToFaderPos(db, maxDb) {
  if (!Number.isFinite(db) || db <= MIN_DB) return 0;
  if (maxDb > 0 && db > 0) return UNITY_POS + (clamp(db, 0, maxDb) / maxDb) * (1 - UNITY_POS);
  const norm = 1 - Math.sqrt(clamp(db, MIN_DB, 0) / MIN_DB);
  return maxDb <= 0 ? norm : norm * UNITY_POS;
}

export function formatDb(db, { digits = 1, unit = " dB" } = {}) {
  if (!Number.isFinite(db) || db <= MIN_DB) return `-∞${unit}`;
  const rounded = db.toFixed(digits);
  return `${db > 0 ? "+" : ""}${rounded === "-0.0" ? "0.0" : rounded}${unit}`;
}

// --- Soft clipper ----------------------------------------------------------
// Unity below the threshold, tanh knee above it, asymptotic to 0 dBFS. The curve
// spans +/-SOFT_CLIP_RANGE so heavily boosted signals are still shaped smoothly.
export const SOFT_CLIP_RANGE = 8;
export const SOFT_CLIP_SIZE = 8192;

export function softClipSample(x, thresholdDb) {
  const threshold = clamp(Math.pow(10, thresholdDb / 20), 0.05, 0.99);
  const headroom = 1 - threshold;
  const magnitude = Math.abs(x);
  if (magnitude <= threshold) return x;
  return Math.sign(x) * (threshold + headroom * Math.tanh((magnitude - threshold) / headroom));
}

export function buildSoftClipCurve(thresholdDb, size = SOFT_CLIP_SIZE, range = SOFT_CLIP_RANGE) {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = ((i / (size - 1)) * 2 - 1) * range;
    curve[i] = softClipSample(x, thresholdDb);
  }
  return curve;
}

// Mirrors the WaveShaperNode lookup (linear interpolation, input clamped to [-1, 1]).
export function applyCurve(curve, input) {
  const u = clamp(input, -1, 1);
  const f = ((u + 1) / 2) * (curve.length - 1);
  const i = Math.floor(f);
  const next = Math.min(i + 1, curve.length - 1);
  return curve[i] + (curve[next] - curve[i]) * (f - i);
}

// --- Metering --------------------------------------------------------------
export function measureBlock(samples) {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSquares += v * v;
  }
  return { peakDb: gainToDb(peak), rmsDb: gainToDb(Math.sqrt(sumSquares / (samples.length || 1))) };
}

// Ballistics: instant attack, fixed-rate decay (dB per second).
export function decayMeter(previousDb, currentDb, elapsedSec, decayDbPerSec = 24) {
  const prev = Number.isFinite(previousDb) ? previousDb : MIN_DB;
  const cur = Number.isFinite(currentDb) ? currentDb : MIN_DB;
  if (cur >= prev) return cur;
  return Math.max(cur, prev - decayDbPerSec * elapsedSec);
}

// --- Device label helpers ---------------------------------------------------
export function inferChannelsFromLabel(label = "") {
  const normalized = String(label || "").toLowerCase();
  if (!normalized) return 2;
  const explicit = normalized.match(/\b(\d{1,2})\s*(?:ch|channel|channels)\b/);
  if (explicit) {
    const count = parseInt(explicit[1], 10);
    if (count > 0) return count;
  }
  if (/(^|\b)mono(\b|$)/.test(normalized)) return 1;
  if (/\b(stereo|2\.0)\b/.test(normalized)) return 2;
  if (/\b(3\.1|4\.0|4\.1|5\.1|6\.1|7\.1|surround|quad|atmos|dolby|dts)\b/.test(normalized)) return 6;
  return 2;
}

export function getCableDescriptor(label = "") {
  const normalized = String(label || "").toLowerCase();
  if (!normalized.includes("cable")) return null;
  const match = normalized.match(/cable(?:\s*[-_]\s*([a-z0-9]+)|\s+([a-z0-9]+))?\s*(input|output)\b/);
  if (!match || !match[3]) return null;
  return { familyKey: `cable:${(match[1] || match[2] || "default").trim()}`, side: match[3] };
}
