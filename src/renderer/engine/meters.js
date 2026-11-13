// Peak + RMS metering with ballistics, peak hold and clip latching.
import { measureBlock, decayMeter, CLIP_DB, MIN_DB } from "./dsp.js";

const PEAK_HOLD_MS = 1200;
const CLIP_HOLD_MS = 2500;

export class MeterChannel {
  constructor() { this.reset(); }

  reset() {
    this.peakDb = MIN_DB;
    this.rmsDb = MIN_DB;
    this.holdDb = MIN_DB;
    this.holdUntil = 0;
    this.clipUntil = 0;
    this.clipped = false;
  }

  update(samples, now, elapsedSec) {
    const { peakDb, rmsDb } = samples ? measureBlock(samples) : { peakDb: MIN_DB, rmsDb: MIN_DB };
    this.peakDb = decayMeter(this.peakDb, peakDb, elapsedSec, 30);
    this.rmsDb = decayMeter(this.rmsDb, rmsDb, elapsedSec, 18);
    if (peakDb >= this.holdDb || now > this.holdUntil) {
      this.holdDb = Number.isFinite(peakDb) ? Math.max(peakDb, MIN_DB) : MIN_DB;
      this.holdUntil = now + PEAK_HOLD_MS;
    }
    if (peakDb >= CLIP_DB) this.clipUntil = now + CLIP_HOLD_MS;
    this.clipped = now < this.clipUntil;
  }

  clearClip() {
    this.clipUntil = 0;
    this.clipped = false;
  }
}

// Drives all meters from one requestAnimationFrame loop; pauses while hidden.
export class MeterLoop {
  constructor(render) {
    this.render = render; // (now, elapsedSec) => void
    this.last = 0;
    this.running = false;
    this.frame = this.frame.bind(this);
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }
  stop() { this.running = false; }
  frame(now) {
    if (!this.running) return;
    const elapsed = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    if (!document.hidden) this.render(now, elapsed);
    requestAnimationFrame(this.frame);
  }
}
