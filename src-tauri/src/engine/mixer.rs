//! The mixing graph (pure: no threads, no OS calls). Runs in 32-bit float.
//!
//!  Strip (per input, same for devices and applications):
//!    source -> [stereo | mono sum] -> trim (dB, up to +24) -> mute/solo -> meter tap
//!           -> send[MON 1 | MON 2] -> bus sum
//!           -> sync delay (karaoke alignment, see `sync`) -> send[MIX] -> bus sum
//!  Bus (per output):
//!    sum -> EQ low/mid/high -> drive -> fader -> soft clipper (optional)
//!        -> lookahead limiter (optional, -1 dB default) -> meter tap -> device
//!
//! Every gain goes through a one-pole smoother (15 ms), so no parameter change clicks.

use super::state::{MasterParams, MixParams, BUS_COUNT};
use super::sync::{self, SourceKind, SyncStrip, ALIGN_BUS, MONITOR_BUSES};
use crate::dsp::biquad::{Biquad, Coefs, EQ_BANDS};
use crate::dsp::delay::DelayLine;
use crate::dsp::jitter::{AdaptiveRing, JitterStats};
use crate::dsp::limiter::Limiter;
use crate::dsp::meter::LevelAccum;
use crate::dsp::softclip::SoftClipper;
use crate::dsp::{db_to_gain, Smoother};

/// Largest block processed in one go. Callers may ask for more; it is split.
pub const MAX_BLOCK: usize = 1024;

pub type SourceKey = u64;

/// One input source (device or app) as seen by the mixer: a jitter buffer fed by the
/// capture thread through a lock-free ring.
pub struct SourceSlot {
    pub key: SourceKey,
    pub kind: SourceKind,
    pub ring: AdaptiveRing,
    pub feed: Option<rtrb::Consumer<f32>>,
    l: Vec<f32>,
    r: Vec<f32>,
    pulled: bool,
}

impl SourceSlot {
    pub fn new(key: SourceKey, ring: AdaptiveRing, feed: Option<rtrb::Consumer<f32>>) -> Self {
        Self { key, kind: SourceKind::Device, ring, feed, l: vec![0.0; MAX_BLOCK], r: vec![0.0; MAX_BLOCK], pulled: false }
    }

    pub fn with_kind(mut self, kind: SourceKind) -> Self {
        self.kind = kind;
        self
    }

    /// Capture + jitter buffer time (ms) from the sound happening to it reaching the mix.
    pub fn input_ms(&self, rate: f32) -> f64 {
        let capture = match self.kind {
            SourceKind::Device => sync::DEVICE_CAPTURE_MS,
            SourceKind::App => sync::APP_CAPTURE_MS,
        };
        capture + self.ring.target() as f64 / rate as f64 * 1000.0
    }

    fn drain_feed(&mut self) {
        let Some(feed) = self.feed.as_mut() else { return };
        let available = feed.slots();
        let take = available - available % 2;
        if take == 0 {
            return;
        }
        if let Ok(chunk) = feed.read_chunk(take) {
            let (a, b) = chunk.as_slices();
            // a may end in the middle of a frame when the ring wraps; handle the seam
            if a.len() % 2 == 0 {
                self.ring.push_interleaved(a);
                self.ring.push_interleaved(b);
            } else {
                let mut seam = [0.0f32; 2];
                self.ring.push_interleaved(&a[..a.len() - 1]);
                seam[0] = a[a.len() - 1];
                seam[1] = b[0];
                self.ring.push_interleaved(&seam);
                self.ring.push_interleaved(&b[1..]);
            }
            chunk.commit_all();
        }
    }
}

struct StripState {
    mono: Smoother,
    trim: Smoother,
    mute: Smoother,
    sends: [Smoother; BUS_COUNT],
    level: LevelAccum,
    /// Karaoke sync delay on the MIX send.
    delay: DelayLine,
    delay_ms: f64,
}

struct BusState {
    eq: [[Biquad; 3]; 2],
    eq_db: [f32; 3],
    drive: Smoother,
    fader: Smoother,
    clip: [SoftClipper; 2],
    limiter: Limiter,
    level: LevelAccum,
    l: Vec<f32>,
    r: Vec<f32>,
}

/// Metering + stats collected since the last snapshot.
#[derive(Clone, Debug, Default)]
pub struct MeterData {
    pub strips: Vec<LevelAccum>,
    pub buses: [LevelAccum; BUS_COUNT],
    pub bus_gr_db: [f32; BUS_COUNT],
    pub sources: Vec<(SourceKey, JitterStats)>,
    /// Karaoke sync: current delay per strip on MIX (ms) and whether auto alignment is engaged.
    pub sync_ms: Vec<f32>,
    pub sync_auto: bool,
}

impl MeterData {
    pub fn merge(&mut self, other: &mut MeterData) {
        if self.strips.len() < other.strips.len() {
            self.strips.resize(other.strips.len(), LevelAccum::default());
        }
        for (a, b) in self.strips.iter_mut().zip(other.strips.iter_mut()) {
            a.merge(&b.take());
        }
        for i in 0..BUS_COUNT {
            self.buses[i].merge(&other.buses[i].take());
            self.bus_gr_db[i] = self.bus_gr_db[i].min(std::mem::replace(&mut other.bus_gr_db[i], 0.0));
        }
        self.sources.clear();
        self.sources.extend_from_slice(&other.sources);
        self.sync_ms.clear();
        self.sync_ms.extend_from_slice(&other.sync_ms);
        self.sync_auto = other.sync_auto;
    }
}

pub struct Mixer {
    rate: f32,
    params: MixParams,
    strips: Vec<StripState>,
    buses: Vec<BusState>,
    pub sources: Vec<SourceSlot>,
    pub meters: MeterData,
    /// Output latency (ms) per bus: device to ears. None = bus not playing.
    bus_out_ms: [Option<f64>; BUS_COUNT],
}

impl Mixer {
    pub fn new(rate: f32, strip_count: usize) -> Self {
        let tc = Smoother::DEFAULT_TC;
        let strips = (0..strip_count)
            .map(|_| StripState {
                mono: Smoother::new(0.0, tc, rate),
                trim: Smoother::new(1.0, tc, rate),
                mute: Smoother::new(0.0, tc, rate),
                sends: std::array::from_fn(|_| Smoother::new(0.0, tc, rate)),
                level: LevelAccum::default(),
                delay: DelayLine::new((rate as f64 * sync::MAX_DELAY_MS / 1000.0).ceil() as usize),
                delay_ms: 0.0,
            })
            .collect();
        let buses = (0..BUS_COUNT)
            .map(|_| BusState {
                eq: Default::default(),
                eq_db: [0.0; 3],
                drive: Smoother::new(1.0, tc, rate),
                fader: Smoother::new(0.0, tc, rate),
                clip: [SoftClipper::new(-6.0), SoftClipper::new(-6.0)],
                limiter: Limiter::new(rate, 0.003, 0.08),
                level: LevelAccum::default(),
                l: vec![0.0; MAX_BLOCK],
                r: vec![0.0; MAX_BLOCK],
            })
            .collect();
        let mut mixer = Self {
            rate,
            params: MixParams::silent(strip_count),
            strips,
            buses,
            sources: Vec::new(),
            meters: MeterData { strips: vec![LevelAccum::default(); strip_count], sync_ms: vec![0.0; strip_count], ..Default::default() },
            bus_out_ms: [None; BUS_COUNT],
        };
        mixer.apply_master(&MasterParams::default());
        mixer
    }

    pub fn rate(&self) -> f32 {
        self.rate
    }

    /// Output latency per bus (ms), set by the engine from the open render streams.
    pub fn set_bus_latency(&mut self, out_ms: [Option<f64>; BUS_COUNT]) {
        self.bus_out_ms = out_ms;
    }

    /// The sync model's view of every strip that is live on MIX.
    fn sync_strips(&self) -> Vec<Option<SyncStrip>> {
        self.params
            .strips
            .iter()
            .map(|p| {
                let key = p.source?;
                if !p.audible || p.sends[ALIGN_BUS] <= 0.0 {
                    return None;
                }
                let src = self.sources.iter().find(|s| s.key == key)?;
                let heard_ms = match src.kind {
                    SourceKind::App => MONITOR_BUSES.iter().find(|&&b| p.sends[b] > 0.0 && self.bus_out_ms[b].is_some()).and_then(|&b| self.bus_out_ms[b]),
                    SourceKind::Device => None,
                };
                Some(SyncStrip { kind: src.kind, input_ms: src.input_ms(self.rate), heard_ms, offset_ms: p.sync_offset_ms as f64 })
            })
            .collect()
    }

    /// Recompute the MIX delays (cheap; done every block so buffer changes follow).
    fn update_sync(&mut self) {
        let strips = self.sync_strips();
        let delays = sync::align(&strips, self.params.auto_sync);
        self.meters.sync_auto = self.params.auto_sync && sync::auto_applies(&strips);
        self.meters.sync_ms.resize(self.strips.len(), 0.0);
        for (i, (strip, ms)) in self.strips.iter_mut().zip(delays).enumerate() {
            let ms = ms.round();
            if ms != strip.delay_ms {
                strip.delay_ms = ms;
                strip.delay.set_delay((ms * self.rate as f64 / 1000.0).round() as usize);
            }
            self.meters.sync_ms[i] = ms as f32;
        }
    }

    /// Current MIX delay per strip (ms).
    pub fn sync_delays_ms(&self) -> Vec<f64> {
        self.strips.iter().map(|s| s.delay_ms).collect()
    }

    pub fn set_params(&mut self, params: MixParams) {
        if params.strips.len() != self.strips.len() {
            // strip count is fixed for the lifetime of a mixer; ignore malformed updates
            return;
        }
        for (s, p) in self.strips.iter_mut().zip(params.strips.iter()) {
            s.mono.set_target(if p.mono { 1.0 } else { 0.0 });
            s.trim.set_target(p.gain);
            s.mute.set_target(if p.audible && p.source.is_some() { 1.0 } else { 0.0 });
            for b in 0..BUS_COUNT {
                s.sends[b].set_target(p.sends[b]);
            }
        }
        for (b, p) in self.buses.iter_mut().zip(params.buses.iter()) {
            b.fader.set_target(p.volume);
        }
        self.apply_master(&params.master);
        self.params = params;
    }

    fn apply_master(&mut self, m: &MasterParams) {
        let drive = db_to_gain(m.drive_db.clamp(0.0, 24.0));
        for bus in self.buses.iter_mut() {
            bus.drive.set_target(if m.drive_db <= 0.0 { 1.0 } else { drive });
            for ch in 0..2 {
                bus.clip[ch].set_threshold_db(m.soft_clip_threshold_db);
            }
            bus.limiter.enabled = m.limiter;
            bus.limiter.set_ceiling_db(m.limiter_ceiling_db);
        }
    }

    fn update_eq(&mut self) {
        let target = self.params.master.eq_db;
        let rate = self.rate as f64;
        for bus in self.buses.iter_mut() {
            for band in 0..3 {
                let cur = bus.eq_db[band];
                let tgt = target[band].clamp(-24.0, 24.0);
                if (cur - tgt).abs() < 1e-3 {
                    continue;
                }
                // glide toward the target over a few blocks to avoid zipper noise
                let next = if (cur - tgt).abs() < 0.05 { tgt } else { cur + (tgt - cur) * 0.35 };
                bus.eq_db[band] = next;
                let (kind, freq) = EQ_BANDS[band];
                let c = Coefs::design(kind, freq, next as f64, rate);
                for ch in 0..2 {
                    bus.eq[ch][band].set(c);
                }
            }
        }
    }

    pub fn add_source(&mut self, slot: SourceSlot) {
        self.sources.retain(|s| s.key != slot.key);
        self.meters.sources.retain(|(k, _)| *k != slot.key);
        self.meters.sources.push((slot.key, slot.ring.stats()));
        self.sources.push(slot);
    }

    pub fn remove_source(&mut self, key: SourceKey) {
        self.sources.retain(|s| s.key != key);
        self.meters.sources.retain(|(k, _)| *k != key);
    }

    pub fn source_mut(&mut self, key: SourceKey) -> Option<&mut SourceSlot> {
        self.sources.iter_mut().find(|s| s.key == key)
    }

    /// Mix `n` frames. Bus outputs are available through [`Mixer::bus_output`] afterwards.
    /// `n` must be <= MAX_BLOCK.
    pub fn process(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        self.update_eq();
        for src in self.sources.iter_mut() {
            src.pulled = false;
            src.drain_feed();
        }
        for bus in self.buses.iter_mut() {
            bus.l[..n].fill(0.0);
            bus.r[..n].fill(0.0);
        }
        self.update_sync();

        // strips -> bus sums
        for (si, strip) in self.strips.iter_mut().enumerate() {
            let Some(key) = self.params.strips[si].source else {
                // keep smoothers moving toward silence, and the delay line flushing
                strip.mute.snap();
                for _ in 0..n {
                    strip.delay.process(0.0, 0.0);
                }
                continue;
            };
            let Some(src) = self.sources.iter_mut().find(|s| s.key == key) else {
                for _ in 0..n {
                    strip.delay.process(0.0, 0.0);
                }
                continue;
            };
            if !src.pulled {
                let (l, r) = (&mut src.l[..n], &mut src.r[..n]);
                src.ring.pull(l, r);
                src.pulled = true;
            }
            let (sl, sr) = (&src.l[..n], &src.r[..n]);
            for i in 0..n {
                let m = strip.mono.next();
                let (mut l, mut r) = (sl[i], sr[i]);
                if m > 0.0 {
                    let mid = 0.5 * (l + r);
                    l = l * (1.0 - m) + mid * m;
                    r = r * (1.0 - m) + mid * m;
                }
                let g = strip.trim.next() * strip.mute.next();
                l *= g;
                r *= g;
                strip.level.add(l, r);
                let (dl, dr) = strip.delay.process(l, r);
                for (b, bus) in self.buses.iter_mut().enumerate() {
                    let s = strip.sends[b].next();
                    if s != 0.0 {
                        let (xl, xr) = if b == ALIGN_BUS { (dl, dr) } else { (l, r) };
                        bus.l[i] += xl * s;
                        bus.r[i] += xr * s;
                    }
                }
            }
        }

        // bus processing
        let soft_clip = self.params.master.soft_clip;
        for bus in self.buses.iter_mut() {
            for i in 0..n {
                let mut l = bus.l[i];
                let mut r = bus.r[i];
                for band in 0..3 {
                    l = bus.eq[0][band].process(l);
                    r = bus.eq[1][band].process(r);
                }
                let g = bus.drive.next() * bus.fader.next();
                l *= g;
                r *= g;
                if soft_clip {
                    l = bus.clip[0].process(l);
                    r = bus.clip[1].process(r);
                }
                let (ol, or) = bus.limiter.process(l, r);
                bus.level.add(ol, or);
                bus.l[i] = ol;
                bus.r[i] = or;
            }
        }

        // meters + stats (copied out by the engine thread)
        for (dst, s) in self.meters.strips.iter_mut().zip(self.strips.iter_mut()) {
            dst.merge(&s.level.take());
        }
        for (b, bus) in self.buses.iter_mut().enumerate() {
            self.meters.buses[b].merge(&bus.level.take());
            self.meters.bus_gr_db[b] = self.meters.bus_gr_db[b].min(bus.limiter.take_min_gr_db());
        }
        for (key, stats) in self.meters.sources.iter_mut() {
            if let Some(src) = self.sources.iter().find(|s| s.key == *key) {
                *stats = src.ring.stats();
            }
        }
    }

    pub fn bus_output(&self, bus: usize, n: usize) -> (&[f32], &[f32]) {
        let b = &self.buses[bus];
        (&b.l[..n], &b.r[..n])
    }

    /// Interleave bus `bus` into `out` (len >= 2 * n).
    pub fn bus_interleaved(&self, bus: usize, n: usize, out: &mut [f32]) {
        let b = &self.buses[bus];
        for i in 0..n {
            out[2 * i] = b.l[i];
            out[2 * i + 1] = b.r[i];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::state::{BusParams, StripParams};

    const FS: f32 = 48_000.0;

    fn sine(freq: f32, amp: f32, frames: usize, phase0: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let s = (2.0 * std::f32::consts::PI * freq * (i + phase0) as f32 / FS).sin() * amp;
            v.push(s);
            v.push(s);
        }
        v
    }

    fn params(strips: Vec<StripParams>) -> MixParams {
        MixParams {
            strips,
            buses: [BusParams { volume: 1.0 }, BusParams { volume: 1.0 }, BusParams { volume: 1.0 }],
            master: MasterParams { soft_clip: false, limiter: false, ..MasterParams::default() },
            auto_sync: true,
        }
    }

    fn strip(source: SourceKey, gain_db: f32, sends: [f32; 3]) -> StripParams {
        StripParams { source: Some(source), gain: db_to_gain(gain_db), audible: true, mono: false, sends, sync_offset_ms: 0.0 }
    }

    /// Feed `frames` of audio per source through the mixer in 480-frame blocks and return
    /// the peak of each bus over the second half (after buffering and smoothing settled).
    fn run(mixer: &mut Mixer, producers: &mut [(rtrb::Producer<f32>, f32, f32)], seconds: usize) -> [f32; 3] {
        let block = 480;
        let mut peaks = [0f32; 3];
        let blocks = seconds * 100;
        for k in 0..blocks {
            for (p, freq, amp) in producers.iter_mut() {
                for x in sine(*freq, *amp, block, k * block) {
                    let _ = p.push(x);
                }
            }
            mixer.process(block);
            if k > blocks / 2 {
                for b in 0..3 {
                    let (l, r) = mixer.bus_output(b, block);
                    for i in 0..block {
                        peaks[b] = peaks[b].max(l[i].abs()).max(r[i].abs());
                    }
                }
            }
        }
        peaks
    }

    fn source(mixer: &mut Mixer, key: SourceKey) -> rtrb::Producer<f32> {
        let (p, c) = rtrb::RingBuffer::new(96_000);
        mixer.add_source(SourceSlot::new(key, AdaptiveRing::new(48_000.0, 48_000.0, 40.0, 25.0), Some(c)));
        p
    }

    #[test]
    fn gain_and_sends_route_to_the_right_buses() {
        let mut m = Mixer::new(FS, 3);
        let p = source(&mut m, 1);
        m.set_params(params(vec![strip(1, 0.0, [1.0, 0.0, db_to_gain(-6.0)]), StripParams::default(), StripParams::default()]));
        let peaks = run(&mut m, &mut [(p, 440.0, 0.25)], 2);
        assert!((peaks[0] - 0.25).abs() < 0.005, "{peaks:?}");
        assert!(peaks[1] < 1e-6, "MON 2 has no send");
        assert!((peaks[2] - 0.125).abs() < 0.005, "MIX at -6 dB: {peaks:?}");
    }

    #[test]
    fn plus_24_db_trim() {
        let mut m = Mixer::new(FS, 3);
        let p = source(&mut m, 1);
        m.set_params(params(vec![strip(1, 24.0, [1.0, 0.0, 0.0]), StripParams::default(), StripParams::default()]));
        let peaks = run(&mut m, &mut [(p, 440.0, 0.01)], 2);
        assert!((peaks[0] - 0.158_49).abs() < 0.003, "{peaks:?}");
    }

    #[test]
    fn two_strips_sum_and_one_source_can_feed_two_strips() {
        let mut m = Mixer::new(FS, 3);
        let a = source(&mut m, 1);
        let b = source(&mut m, 2);
        m.set_params(params(vec![
            strip(1, 0.0, [1.0, 0.0, 0.0]),
            strip(2, 0.0, [1.0, 0.0, 0.0]),
            strip(2, 0.0, [0.0, 1.0, 0.0]),
        ]));
        // same frequency and phase: amplitudes add
        let peaks = run(&mut m, &mut [(a, 300.0, 0.2), (b, 300.0, 0.3)], 2);
        assert!((peaks[0] - 0.5).abs() < 0.01, "{peaks:?}");
        assert!((peaks[1] - 0.3).abs() < 0.01, "shared source on strip 3: {peaks:?}");
    }

    #[test]
    fn mute_and_mono() {
        let mut m = Mixer::new(FS, 3);
        let (mut p, c) = rtrb::RingBuffer::new(96_000);
        m.add_source(SourceSlot::new(1, AdaptiveRing::new(48_000.0, 48_000.0, 40.0, 25.0), Some(c)));
        let mut s = strip(1, 0.0, [1.0, 0.0, 0.0]);
        s.mono = true;
        m.set_params(params(vec![s.clone(), StripParams::default(), StripParams::default()]));
        // left only: mono sums to half on both sides
        for k in 0..200 {
            for i in 0..480 {
                let x = (2.0 * std::f32::consts::PI * 440.0 * (k * 480 + i) as f32 / FS).sin() * 0.4;
                let _ = p.push(x);
                let _ = p.push(0.0);
            }
            m.process(480);
        }
        let (l, r) = m.bus_output(0, 480);
        let pl = l.iter().fold(0f32, |a, &x| a.max(x.abs()));
        let pr = r.iter().fold(0f32, |a, &x| a.max(x.abs()));
        assert!((pl - 0.2).abs() < 0.01 && (pr - 0.2).abs() < 0.01, "{pl} {pr}");

        s.audible = false;
        m.set_params(params(vec![s, StripParams::default(), StripParams::default()]));
        for k in 0..50 {
            for i in 0..480 {
                let _ = p.push(((k * 480 + i) as f32 * 0.05).sin() * 0.4);
                let _ = p.push(0.0);
            }
            m.process(480);
        }
        let (l, _) = m.bus_output(0, 480);
        assert!(l.iter().all(|x| x.abs() < 1e-4), "muted");
    }

    #[test]
    fn limiter_holds_minus_one_db_with_hot_inputs() {
        let mut m = Mixer::new(FS, 3);
        let a = source(&mut m, 1);
        let b = source(&mut m, 2);
        let mut p = params(vec![strip(1, 24.0, [1.0, 1.0, 1.0]), strip(2, 12.0, [1.0, 1.0, 1.0]), StripParams::default()]);
        p.master = MasterParams { soft_clip: true, limiter: true, ..MasterParams::default() };
        p.buses = [BusParams { volume: db_to_gain(12.0) }, BusParams { volume: 1.0 }, BusParams { volume: 1.0 }];
        m.set_params(p);
        let peaks = run(&mut m, &mut [(a, 220.0, 0.9), (b, 331.0, 0.9)], 2);
        let ceiling = 10f32.powf(-1.0 / 20.0);
        for pk in peaks {
            assert!(pk <= ceiling + 1e-5, "{peaks:?}");
            assert!(pk > 0.8, "still loud: {peaks:?}");
        }
        assert!(m.meters.bus_gr_db[0] < -1.0);
    }

    #[test]
    fn meters_report_strip_and_bus_levels() {
        let mut m = Mixer::new(FS, 3);
        let a = source(&mut m, 1);
        m.set_params(params(vec![strip(1, 0.0, [1.0, 0.0, 0.0]), StripParams::default(), StripParams::default()]));
        run(&mut m, &mut [(a, 440.0, 0.5)], 1);
        let mut snap = MeterData::default();
        snap.merge(&mut m.meters);
        let (peak, _) = snap.strips[0].levels_db();
        assert!((peak - (-6.02)).abs() < 0.1, "{peak}");
        let (bus_peak, _) = snap.buses[0].levels_db();
        assert!((bus_peak - (-6.02)).abs() < 0.1);
        assert_eq!(snap.buses[1].levels_db().0, f32::NEG_INFINITY);
        assert_eq!(snap.sources.len(), 1);
    }

    /// Index of the first sample whose magnitude exceeds `thr`.
    fn onset(x: &[f32], thr: f32) -> Option<usize> {
        x.iter().position(|v| v.abs() > thr)
    }

    /// One click per source at the same instant; returns every bus's left channel.
    fn click_run(m: &mut Mixer, p_app: &mut rtrb::Producer<f32>, p_mic: &mut rtrb::Producer<f32>) -> [Vec<f32>; 3] {
        let block = 480;
        let mut out: [Vec<f32>; 3] = Default::default();
        for k in 0..150 {
            for p in [&mut *p_app, &mut *p_mic] {
                for i in 0..block {
                    let x = if k == 50 && i == 0 { 0.9 } else { 0.0 };
                    let _ = p.push(x);
                    let _ = p.push(x);
                }
            }
            m.process(block);
            for (b, o) in out.iter_mut().enumerate() {
                o.extend_from_slice(m.bus_output(b, block).0);
            }
        }
        out
    }

    #[test]
    fn karaoke_sync_delays_music_on_mix_only() {
        let mut m = Mixer::new(FS, 3);
        let (mut pa, ca) = rtrb::RingBuffer::new(96_000);
        let (mut pm, cm) = rtrb::RingBuffer::new(96_000);
        // same jitter target for both so their inputs line up before any sync
        m.add_source(SourceSlot::new(1, AdaptiveRing::new(48_000.0, 48_000.0, 20.0, 15.0), Some(ca)).with_kind(SourceKind::App));
        m.add_source(SourceSlot::new(2, AdaptiveRing::new(48_000.0, 48_000.0, 20.0, 15.0), Some(cm)));
        // music on MON 1 + MIX, mic on MON 2 + MIX (so each monitor bus shows one source)
        m.set_params(params(vec![strip(1, 0.0, [1.0, 0.0, 1.0]), strip(2, 0.0, [0.0, 1.0, 1.0]), StripParams::default()]));
        m.set_bus_latency([Some(25.0), Some(25.0), Some(10.0)]);
        let out = click_run(&mut m, &mut pa, &mut pm);
        // heard after 25 ms on MON 1, mic input = 10 + 20 ms: music held back 55 ms on MIX
        assert_eq!(m.sync_delays_ms(), vec![55.0, 0.0, 0.0]);
        assert!(m.meters.sync_auto);
        let music_mon = onset(&out[0], 0.5).unwrap();
        let mic_mon = onset(&out[1], 0.5).unwrap();
        assert_eq!(music_mon, mic_mon, "no delay on monitor buses");
        // MIX has the mic click right away and the music click 55 ms later
        let first = onset(&out[2], 0.5).unwrap();
        assert_eq!(first, mic_mon);
        let second = first + 100 + onset(&out[2][first + 100..], 0.5).unwrap();
        assert_eq!(second - first, 55 * 48);
    }

    #[test]
    fn karaoke_sync_off_and_manual_offset() {
        let mut m = Mixer::new(FS, 3);
        let (_pa, ca) = rtrb::RingBuffer::new(96_000);
        let (_pm, cm) = rtrb::RingBuffer::new(96_000);
        m.add_source(SourceSlot::new(1, AdaptiveRing::new(48_000.0, 48_000.0, 20.0, 15.0), Some(ca)).with_kind(SourceKind::App));
        m.add_source(SourceSlot::new(2, AdaptiveRing::new(48_000.0, 48_000.0, 10.0, 10.0), Some(cm)));
        m.set_bus_latency([Some(25.0), None, Some(10.0)]);
        let mut p = params(vec![strip(1, 0.0, [1.0, 0.0, 1.0]), strip(2, 0.0, [1.0, 0.0, 1.0]), StripParams::default()]);
        p.auto_sync = false;
        m.set_params(p.clone());
        m.process(480);
        assert_eq!(m.sync_delays_ms(), vec![0.0, 0.0, 0.0]);
        // manual: mic 12 ms later
        p.strips[1].sync_offset_ms = 12.0;
        m.set_params(p.clone());
        m.process(480);
        assert_eq!(m.sync_delays_ms(), vec![0.0, 12.0, 0.0]);
        // auto on: 25 + (10 + 10) = 45 on the music; the mic's +12 offset moves the mic
        // 12 ms later relative to the music, so the music needs 12 ms less
        p.auto_sync = true;
        m.set_params(p.clone());
        m.process(480);
        assert_eq!(m.sync_delays_ms(), vec![33.0, 0.0, 0.0]);
        // mic not on MIX: nothing to align
        p.strips[1].sends[2] = 0.0;
        m.set_params(p);
        m.process(480);
        assert_eq!(m.sync_delays_ms(), vec![0.0, 0.0, 0.0]);
        assert!(!m.meters.sync_auto);
    }
}
