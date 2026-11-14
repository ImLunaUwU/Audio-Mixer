// Settings from the Electron build carry over: Chromium device ids are rebound by label.
import test from "node:test";
import assert from "node:assert";
import { findReplacement, normalizeLabel } from "../src/renderer/devices.js";

test("normalizes Chromium labels to Windows friendly names", () => {
  assert.equal(normalizeLabel("Default - Headphones (Arctis 7 Game) (1038:12ad)"), "headphones (arctis 7 game)");
  assert.equal(normalizeLabel("Line 1 (Virtual Audio Cable)"), "line 1 (virtual audio cable)");
});

test("rebinds an Electron-era device id by label", () => {
  const candidates = [
    { deviceId: "{0.0.0.00000000}.{a}", label: "Speakers (Realtek(R) Audio)" },
    { deviceId: "{0.0.0.00000000}.{b}", label: "Headphones (Arctis 7 Game)" }
  ];
  assert.equal(findReplacement("Headphones (Arctis 7 Game) (1038:12ad)", candidates), "{0.0.0.00000000}.{b}");
  assert.equal(findReplacement("Speakers (Realtek(R) Audio)", candidates), "{0.0.0.00000000}.{a}");
  assert.equal(findReplacement("Gone device", candidates), "");
  assert.equal(findReplacement("Speakers (Realtek(R) Audio)", candidates, new Set(["{0.0.0.00000000}.{a}"])), "");
});
