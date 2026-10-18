// Mixer audio engine: a modular Web Audio graph.
//
//  Strip (per input, identical for hardware devices and applications):
//    source -> [stereo | mono-sum] -> trim (gain dB, up to +24) -> mute/solo -> post-fader tap
//           -> send[monitor|monitor2|output] -> bus input
//
//  Bus (per output):
//    input (sum) -> EQ low/mid/high -> drive -> fader -> soft clipper (optional)
//           -> lookahead limiter (optional) -> meter tap + MediaStreamDestination
//           -> output AudioContext with setSinkId(device)
//
// Every parameter change goes through setTargetAtTime ramps to avoid zipper noise.

import { dbToGain, buildSoftClipCurve, SOFT_CLIP_RANGE } from "./dsp.js";
import { loadWorklets } from "./worklets.js";

export const BUS_IDS = ["monitor", "monitor2", "output"];
const RAMP_TC = 0.015; // seconds (≈ 50 ms to settle)
const SAMPLE_RATE = 48000; // matches app-capture PCM, avoids resampling

export class MixerEngine {
  constructor({ AudioContextCtor = globalThis.AudioContext, latencyHint = "interactive", inputCount = 3 } = {}) {
    this.AudioContextCtor = AudioContextCtor;
    this.latencyHint = latencyHint;
    this.inputCount = inputCount;
    this.ctx = null;
    this.buses = {};
    this.strips = [];
    this.outputs = {};
    this.soloActive = false;
    this.onLimiterReduction = null;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new this.AudioContextCtor({ latencyHint: this.latencyHint, sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    await loadWorklets(ctx);
    BUS_IDS.forEach(id => { this.buses[id] = this.createBus(id); });
    for (let i = 0; i < this.inputCount; i++) this.strips.push(this.createStrip(i));
    await this.resume();
  }

  async resume() {
    const contexts = [this.ctx, ...Object.values(this.outputs).map(o => o.ctx)].filter(Boolean);
    await Promise.all(contexts.map(c => (c.state === "suspended" ? c.resume().catch(() => {}) : null)));
  }

  ramp(param, value, tc = RAMP_TC) {
    if (!param) return;
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tc);
  }

  createAnalyser() {
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    return { analyser, buffer: new Float32Array(analyser.fftSize) };
  }

  // ---------------------------------------------------------------- buses
  createBus(id) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const eqLow = ctx.createBiquadFilter();
    const eqMid = ctx.createBiquadFilter();
    const eqHigh = ctx.createBiquadFilter();
    eqLow.type = "lowshelf"; eqLow.frequency.value = 180;
    eqMid.type = "peaking"; eqMid.frequency.value = 1400; eqMid.Q.value = 0.9;
    eqHigh.type = "highshelf"; eqHigh.frequency.value = 5600;
    const drive = ctx.createGain();
    const fader = ctx.createGain();
    const clipPre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const limiter = new AudioWorkletNode(ctx, "lookahead-limiter", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { lookahead: 0.003 }
    });
    const meter = this.createAnalyser();
    const destination = ctx.createMediaStreamDestination();

    input.connect(eqLow).connect(eqMid).connect(eqHigh).connect(drive).connect(fader)
      .connect(clipPre).connect(shaper).connect(limiter);
    limiter.connect(meter.analyser);
    limiter.connect(destination);

    const bus = { id, input, eqLow, eqMid, eqHigh, drive, fader, clipPre, shaper, limiter, meter, destination, gainReductionDb: 0 };
    limiter.port.onmessage = event => {
      bus.gainReductionDb = event.data;
      if (this.onLimiterReduction) this.onLimiterReduction(id, event.data);
    };
    return bus;
  }

  setBusParams(id, { volumeDb, mute, active }) {
    const bus = this.buses[id];
    if (!bus) return;
    this.ramp(bus.fader.gain, !active || mute ? 0 : dbToGain(volumeDb));
  }

  setMasterProcessing({ eq, driveDb, softClip, limiter }) {
    Object.values(this.buses).forEach(bus => {
      if (eq) {
        this.ramp(bus.eqLow.gain, eq.low);
        this.ramp(bus.eqMid.gain, eq.mid);
        this.ramp(bus.eqHigh.gain, eq.high);
      }
      if (Number.isFinite(driveDb)) this.ramp(bus.drive.gain, dbToGain(driveDb));
      if (softClip) {
        // WaveShaper indexes its curve with input in [-1, 1]; scale down so the curve
        // spans +/-SOFT_CLIP_RANGE. Curve values are already in output units.
        const enabled = !!softClip.enabled;
        bus.clipPre.gain.value = enabled ? 1 / SOFT_CLIP_RANGE : 1;
        bus.shaper.curve = enabled ? buildSoftClipCurve(softClip.thresholdDb) : null;
        bus.shaper.oversample = enabled ? "4x" : "none";
      }
      if (limiter) {
        const t = this.ctx.currentTime;
        bus.limiter.parameters.get("enabled").setValueAtTime(limiter.enabled ? 1 : 0, t);
        bus.limiter.parameters.get("ceiling").setValueAtTime(dbToGain(limiter.ceilingDb), t);
      }
    });
  }

  // --------------------------------------------------------------- strips
  createStrip(index) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    // Stereo and mono paths run in parallel; toggling mono crossfades between them.
    const stereoPath = ctx.createGain();
    const monoPath = ctx.createGain();
    monoPath.channelCount = 1;
    monoPath.channelCountMode = "explicit";
    monoPath.channelInterpretation = "speakers";
    const monoUp = ctx.createGain(); // mono -> stereo upmix (speakers interpretation)
    monoUp.channelCount = 2;
    monoUp.channelCountMode = "explicit";
    const trim = ctx.createGain();
    const muteGain = ctx.createGain();
    const meter = this.createAnalyser();
    const sends = {};

    input.connect(stereoPath).connect(trim);
    input.connect(monoPath).connect(monoUp).connect(trim);
    monoPath.gain.value = 0;
    trim.connect(muteGain);
    muteGain.connect(meter.analyser);
    BUS_IDS.forEach(id => {
      const send = ctx.createGain();
      send.gain.value = 0;
      muteGain.connect(send).connect(this.buses[id].input);
      sends[id] = send;
    });

    return { index, input, stereoPath, monoPath, monoUp, trim, muteGain, meter, sends, source: null, stream: null };
  }

  setStripStream(index, stream) {
    const strip = this.strips[index];
    if (!strip) return;
    if (strip.source) {
      // Only cut the link into this strip: an app node may also feed another strip.
      try { strip.source.disconnect(strip.input); } catch (_) {}
      strip.source = null;
    }
    strip.stream = stream || null;
    if (stream) {
      strip.source = this.ctx.createMediaStreamSource(stream);
      strip.source.connect(strip.input);
    }
  }

  setStripNode(index, node) {
    // Direct node input (used for application capture: no MediaStream round-trip).
    const strip = this.strips[index];
    if (!strip) return;
    this.setStripStream(index, null);
    if (node) {
      node.connect(strip.input);
      strip.source = node;
    }
  }

  // cfg = normalized input config, busActive = { monitor: bool, ... }
  setStripParams(index, cfg, busActive) {
    const strip = this.strips[index];
    if (!strip || !cfg) return;
    const audible = cfg.enabled && !cfg.mute && (!this.soloActive || cfg.solo);
    this.ramp(strip.trim.gain, dbToGain(cfg.gainDb));
    this.ramp(strip.muteGain.gain, audible ? 1 : 0);
    this.ramp(strip.stereoPath.gain, cfg.forceMono ? 0 : 1);
    this.ramp(strip.monoPath.gain, cfg.forceMono ? 1 : 0);
    BUS_IDS.forEach(id => {
      const send = cfg.sends[id];
      const on = busActive[id] && send && send.on;
      this.ramp(strip.sends[id].gain, on ? dbToGain(send.levelDb) : 0);
    });
  }

  // ---------------------------------------------------------- output sinks
  async setBusOutputDevice(id, deviceId) {
    const bus = this.buses[id];
    if (!bus) return false;
    let output = this.outputs[id];
    if (!deviceId) {
      if (output) output.gain.gain.value = 0;
      return true;
    }
    if (!output) {
      const ctx = new this.AudioContextCtor({ latencyHint: this.latencyHint, sampleRate: SAMPLE_RATE });
      const source = ctx.createMediaStreamSource(bus.destination.stream);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      output = { ctx, source, gain, deviceId: null };
      this.outputs[id] = output;
    }
    if (output.ctx.state === "suspended") await output.ctx.resume().catch(() => {});
    if (output.deviceId !== deviceId) {
      if (typeof output.ctx.setSinkId !== "function") throw new Error("This Electron build cannot select output devices.");
      await output.ctx.setSinkId(deviceId);
      output.deviceId = deviceId;
    }
    output.gain.gain.value = 1;
    return true;
  }

  async close() {
    const contexts = [this.ctx, ...Object.values(this.outputs).map(o => o.ctx)].filter(Boolean);
    this.ctx = null;
    this.outputs = {};
    this.buses = {};
    this.strips = [];
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
  }
}
