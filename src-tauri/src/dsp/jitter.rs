//! Adaptive jitter buffer + drift-correcting resampler (port of the Electron build's
//! `app-pcm-player` AudioWorklet, now used for every input and every secondary output).
//!
//! - Buffers up to `target` before playing. The target adapts: x1.5 on every real dropout,
//!   x0.9 after 20 s without one, clamped to [min, 400 ms].
//! - Tells a real dropout apart from the source going quiet. Process loopback delivers
//!   nothing while the app is silent or paused, so the ring also runs dry then. After running
//!   dry it rebuffers either way, then looks at how the data came back: as a burst (late
//!   delivery: a real dropout, counted, target grows) or at the normal real-time pace (the app
//!   was just quiet: a "quiet gap", not counted as a dropout, target unchanged).
//! - Corrects clock drift between producer and consumer by nudging the playback rate
//!   (+/-0.5 % max, proportional to the smoothed buffer error) instead of dropping or inserting
//!   samples. The same variable-rate reader also converts between sample rates.
//! - 4-point cubic (Catmull-Rom) interpolation.
//! - Fades out over the last samples before running dry and fades back in on resume.
//! - On overflow (burst after a stall) skips ahead to the target with a short crossfade.
//! - Never allocates after construction.

const FADE: f32 = 240.0; // 5 ms at 48 kHz
const XFADE: usize = 256;
const MAX_CORRECTION: f64 = 0.005;
const SHRINK_AFTER_S: f64 = 20.0;
const MAX_TARGET_S: f64 = 0.4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JitterStats {
    pub fill_ms: u32,
    pub target_ms: u32,
    pub underruns: u32,
    pub gaps: u32,
    /// Playback rate relative to nominal (1.0 = no drift correction).
    pub rate: f64,
}

#[derive(Clone, Debug)]
pub struct AdaptiveRing {
    cap: usize,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    read: usize,
    fill: usize,
    frac: f64,
    in_rate: f64,
    out_rate: f64,
    base_ratio: f64,
    rate: f64,
    target: usize,
    min_target: usize,
    max_target: usize,
    base_target_ms: f64,
    base_min_ms: f64,
    playing: bool,
    gain: f32,
    fade_dir: i8,
    avg_fill: f64,
    underruns: u32,
    gaps: u32,
    since_underrun: u64,
    starved: bool,
    clock: u64,
    resume_frame: Option<u64>,
    resume_fill: usize,
    xfade: usize,
    x_read: usize,
    x_frac: f64,
}

impl AdaptiveRing {
    /// `in_rate`: producer sample rate, `out_rate`: consumer sample rate.
    pub fn new(in_rate: f64, out_rate: f64, target_ms: f64, min_target_ms: f64) -> Self {
        let cap = (in_rate * 2.0) as usize; // 2 s ring
        let mut ring = Self {
            cap,
            left: vec![0.0; cap],
            right: vec![0.0; cap],
            write: 0,
            read: 0,
            fill: 0,
            frac: 0.0,
            in_rate,
            out_rate,
            base_ratio: in_rate / out_rate,
            rate: in_rate / out_rate,
            target: 0,
            min_target: 0,
            max_target: 0,
            base_target_ms: target_ms,
            base_min_ms: min_target_ms,
            playing: false,
            gain: 0.0,
            fade_dir: 0,
            avg_fill: 0.0,
            underruns: 0,
            gaps: 0,
            since_underrun: 0,
            starved: false,
            clock: 0,
            resume_frame: None,
            resume_fill: 0,
            xfade: 0,
            x_read: 0,
            x_frac: 0.0,
        };
        ring.configure(target_ms, min_target_ms);
        ring
    }

    fn ms_to_frames(&self, ms: f64) -> usize {
        (self.in_rate * ms / 1000.0).round() as usize
    }

    /// Change the latency profile (keeps the audio playing).
    pub fn configure(&mut self, target_ms: f64, min_target_ms: f64) {
        self.base_target_ms = target_ms;
        self.base_min_ms = min_target_ms;
        self.min_target = self.ms_to_frames(if min_target_ms > 0.0 { min_target_ms } else { 30.0 });
        self.target = self.min_target.max(self.ms_to_frames(if target_ms > 0.0 { target_ms } else { 60.0 }));
        self.max_target = self.ms_to_frames(MAX_TARGET_S * 1000.0).max(self.target);
    }

    /// Fresh start after the source was re-initialised (e.g. DUMP moved the app's output):
    /// drop stale audio, rebuffer at the base target and do not count the switch as a dropout.
    pub fn reset(&mut self) {
        self.write = 0;
        self.read = 0;
        self.fill = 0;
        self.frac = 0.0;
        self.playing = false;
        self.gain = 0.0;
        self.fade_dir = 0;
        self.xfade = 0;
        self.starved = false;
        self.resume_frame = None;
        self.since_underrun = 0;
        self.avg_fill = 0.0;
        let (t, m) = (self.base_target_ms, self.base_min_ms);
        self.configure(t, m);
    }

    pub fn fill(&self) -> usize {
        self.fill
    }

    pub fn target(&self) -> usize {
        self.target
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    #[inline]
    fn push_frame(&mut self, l: f32, r: f32) {
        self.left[self.write] = l;
        self.right[self.write] = r;
        self.write = (self.write + 1) % self.cap;
        if self.fill < self.cap {
            self.fill += 1;
        } else {
            self.read = (self.read + 1) % self.cap;
        }
    }

    /// Push interleaved stereo frames from the producer.
    pub fn push_interleaved(&mut self, data: &[f32]) {
        if data.len() < 2 {
            return;
        }
        for frame in data.chunks_exact(2) {
            self.push_frame(frame[0], frame[1]);
        }
        if self.starved && self.resume_frame.is_none() {
            self.resume_frame = Some(self.clock);
            self.resume_fill = self.fill;
        }
    }

    /// Ring reached the target again after running dry: was it a dropout or a quiet gap?
    fn classify_resume(&mut self) {
        if !self.starved {
            return;
        }
        let need = self.target as f64 - self.resume_fill as f64;
        let elapsed_in = match self.resume_frame {
            Some(f) => (self.clock - f) as f64 * self.base_ratio,
            None => 0.0,
        };
        let burst = need <= 0.0 || elapsed_in < need * 0.4;
        if burst {
            self.underruns += 1;
            self.since_underrun = 0;
            self.target = self.max_target.min((self.target as f64 * 1.5).round() as usize);
        } else {
            self.gaps += 1;
        }
        self.starved = false;
        self.resume_frame = None;
    }

    #[inline]
    fn cubic(buf: &[f32], cap: usize, pos: usize, t: f64) -> f32 {
        let ym1 = buf[(pos + cap - 1) % cap] as f64;
        let y0 = buf[pos] as f64;
        let y1 = buf[(pos + 1) % cap] as f64;
        let y2 = buf[(pos + 2) % cap] as f64;
        let c1 = 0.5 * (y1 - ym1);
        let c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
        let c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
        (((c3 * t + c2) * t + c1) * t + y0) as f32
    }

    /// Fill `out_l`/`out_r` (same length) for the consumer. Silence while buffering.
    pub fn pull(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        self.clock += n as u64;
        // smoothed buffer level drives drift correction (time constant independent of n)
        let alpha = 1.0 - 0.99f64.powf(n as f64 / 128.0);
        self.avg_fill += (self.fill as f64 - self.avg_fill) * alpha;

        if !self.playing {
            if self.fill >= self.target && self.fill >= 3 {
                self.classify_resume();
                self.playing = true;
                self.gain = 0.0;
                self.fade_dir = 1;
                self.avg_fill = self.fill as f64;
            } else {
                out_l[..n].fill(0.0);
                out_r[..n].fill(0.0);
                return;
            }
        }

        // overflow after a stall: skip ahead to the target with a crossfade
        if self.xfade == 0 && self.fill > self.target * 3 + n {
            let skip = self.fill - self.target;
            self.x_read = self.read;
            self.x_frac = self.frac;
            self.read = (self.read + skip) % self.cap;
            self.fill -= skip;
            self.xfade = XFADE;
            self.avg_fill = self.fill as f64;
        }

        let error = (self.avg_fill - self.target as f64) / self.target.max(1) as f64;
        let correction = (error * 0.004).clamp(-MAX_CORRECTION, MAX_CORRECTION);
        self.rate = self.base_ratio * (1.0 + correction);

        let cap = self.cap;
        for i in 0..n {
            if self.fill < 3 {
                out_l[i] = 0.0;
                out_r[i] = 0.0;
                if self.playing {
                    self.playing = false;
                    self.starved = true;
                    self.resume_frame = None;
                }
                continue;
            }
            if self.fade_dir != 0 {
                self.gain += self.fade_dir as f32 / FADE;
                if self.gain >= 1.0 {
                    self.gain = 1.0;
                    self.fade_dir = 0;
                }
            }
            // start fading out early if we are about to run dry
            if (self.fill as f32) < FADE && self.fade_dir == 0 && self.gain == 1.0 {
                self.fade_dir = -1;
            }
            if self.fade_dir < 0 && self.gain <= 0.0 {
                self.gain = 0.0;
            }
            let mut l = Self::cubic(&self.left, cap, self.read, self.frac);
            let mut r = Self::cubic(&self.right, cap, self.read, self.frac);
            if self.xfade > 0 {
                let t = self.xfade as f32 / XFADE as f32;
                l = l * (1.0 - t) + Self::cubic(&self.left, cap, self.x_read, self.x_frac) * t;
                r = r * (1.0 - t) + Self::cubic(&self.right, cap, self.x_read, self.x_frac) * t;
                let xa = self.x_frac + self.rate;
                let xw = xa.floor();
                self.x_frac = xa - xw;
                self.x_read = (self.x_read + xw as usize) % cap;
                self.xfade -= 1;
            }
            out_l[i] = l * self.gain;
            out_r[i] = r * self.gain;
            let adv = self.frac + self.rate;
            let whole = adv.floor();
            self.frac = adv - whole;
            let whole = (whole as usize).min(self.fill);
            self.read = (self.read + whole) % cap;
            self.fill -= whole;
            if self.fade_dir < 0 && (self.fill as f32) >= FADE * 2.0 {
                self.fade_dir = 1; // data arrived in time
            }
        }
        self.since_underrun += n as u64;
        if self.since_underrun as f64 > self.out_rate * SHRINK_AFTER_S && self.target > self.min_target {
            self.target = self.min_target.max((self.target as f64 * 0.9).round() as usize);
            self.since_underrun = 0;
        }
    }

    pub fn stats(&self) -> JitterStats {
        JitterStats {
            fill_ms: (self.fill as f64 / self.in_rate * 1000.0).round() as u32,
            target_ms: (self.target as f64 / self.in_rate * 1000.0).round() as u32,
            underruns: self.underruns,
            gaps: self.gaps,
            rate: self.rate / self.base_ratio,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    const FS: f64 = 48_000.0;

    /// Producer that generates a sine at `freq` and pushes `chunk` frames at a time.
    struct Sine {
        phase: f64,
        freq: f64,
        rate: f64,
    }
    impl Sine {
        fn chunk(&mut self, frames: usize) -> Vec<f32> {
            let mut v = Vec::with_capacity(frames * 2);
            for _ in 0..frames {
                let s = (self.phase * 2.0 * PI).sin() as f32 * 0.5;
                v.push(s);
                v.push(s);
                self.phase = (self.phase + self.freq / self.rate) % 1.0;
            }
            v
        }
    }

    fn run(ring: &mut AdaptiveRing, out_frames: usize, block: usize, mut produce: impl FnMut(usize, &mut AdaptiveRing)) -> Vec<f32> {
        let mut out = Vec::new();
        let mut l = vec![0.0; block];
        let mut r = vec![0.0; block];
        let mut done = 0;
        let mut step = 0;
        while done < out_frames {
            produce(step, ring);
            ring.pull(&mut l, &mut r);
            out.extend_from_slice(&l);
            done += block;
            step += 1;
        }
        out
    }

    fn zero_crossings(x: &[f32]) -> usize {
        x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count()
    }

    #[test]
    fn steady_stream_plays_without_dropouts() {
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 1000.0, rate: FS };
        let out = run(&mut ring, 48_000 * 5, 480, |_, r| r.push_interleaved(&sine.chunk(480)));
        let s = ring.stats();
        assert_eq!(s.underruns, 0);
        assert_eq!(s.gaps, 0);
        // 1 kHz for ~5 s minus the initial buffering
        let zc = zero_crossings(&out[48_000..]) as f64;
        assert!((zc / 4.0 - 1000.0).abs() < 5.0, "{zc}");
        // fill hovers around the target
        assert!((s.fill_ms as i64 - s.target_ms as i64).abs() < 25, "{s:?}");
    }

    #[test]
    fn resamples_44k1_to_48k_at_the_right_pitch() {
        let in_rate = 44_100.0;
        let mut ring = AdaptiveRing::new(in_rate, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 1000.0, rate: in_rate };
        // producer delivers 441 frames per 10 ms, consumer pulls 480 per 10 ms
        let out = run(&mut ring, 48_000 * 6, 480, |_, r| r.push_interleaved(&sine.chunk(441)));
        assert_eq!(ring.stats().underruns, 0);
        let tail = &out[96_000..];
        let freq = zero_crossings(tail) as f64 / (tail.len() as f64 / FS);
        assert!((freq - 1000.0).abs() < 3.0, "{freq}");
    }

    #[test]
    fn cubic_interpolation_is_clean() {
        // Resampled sine vs ideal sine: error well below -50 dB at 1 kHz.
        let in_rate = 44_100.0;
        let mut ring = AdaptiveRing::new(in_rate, FS, 50.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 1000.0, rate: in_rate };
        let out = run(&mut ring, 48_000 * 4, 480, |_, r| r.push_interleaved(&sine.chunk(441)));
        // estimate amplitude + phase from a window, then compare
        let tail = &out[120_000..130_000];
        let peak = tail.iter().fold(0f32, |m, &x| m.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.005, "amplitude preserved: {peak}");
        // second difference energy (smoothness): no clicks
        let max_jump = tail.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0f32, f32::max);
        let ideal = (2.0 * PI * 1000.0 / FS).sin() as f32 * 0.5;
        assert!(max_jump < ideal * 1.05, "{max_jump} vs {ideal}");
    }

    #[test]
    fn corrects_clock_drift() {
        // Producer runs 0.2 % fast: the ring must speed up instead of overflowing.
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        let mut acc = 0.0f64;
        run(&mut ring, 48_000 * 60, 480, |_, r| {
            acc += 480.0 * 1.002;
            let n = acc.floor() as usize;
            acc -= n as f64;
            r.push_interleaved(&sine.chunk(n));
        });
        let s = ring.stats();
        assert_eq!(s.underruns, 0, "{s:?}");
        assert!(s.rate > 1.0015 && s.rate < 1.0025, "{s:?}");
        assert!((s.fill_ms as i64 - s.target_ms as i64).abs() < 30, "{s:?}");
    }

    #[test]
    fn quiet_gap_is_not_a_dropout() {
        // App goes silent for 2 s (process loopback sends nothing), then resumes in real time.
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        run(&mut ring, 48_000 * 6, 480, |step, r| {
            let silent = (200..400).contains(&step);
            if !silent {
                r.push_interleaved(&sine.chunk(480));
            }
        });
        let s = ring.stats();
        assert_eq!(s.underruns, 0, "{s:?}");
        assert_eq!(s.gaps, 1, "{s:?}");
        assert_eq!(s.target_ms, 60, "target unchanged");
    }

    #[test]
    fn late_burst_is_a_dropout_and_grows_the_buffer() {
        // Delivery stalls for 150 ms and then everything arrives at once.
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        run(&mut ring, 48_000 * 4, 480, |step, r| {
            if (200..215).contains(&step) {
                return;
            }
            if step == 215 {
                r.push_interleaved(&sine.chunk(480 * 16));
            } else {
                r.push_interleaved(&sine.chunk(480));
            }
        });
        let s = ring.stats();
        assert_eq!(s.underruns, 1, "{s:?}");
        assert_eq!(s.gaps, 0, "{s:?}");
        assert_eq!(s.target_ms, 90, "target grew x1.5");
    }

    #[test]
    fn overflow_skips_ahead_to_target() {
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        let mut l = vec![0.0; 480];
        let mut r = vec![0.0; 480];
        ring.push_interleaved(&sine.chunk(4800));
        ring.pull(&mut l, &mut r);
        ring.push_interleaved(&sine.chunk(48_000)); // a 1 s burst
        ring.pull(&mut l, &mut r);
        assert!(ring.fill() <= ring.target() + 480, "{} {}", ring.fill(), ring.target());
    }

    #[test]
    fn reset_flushes_without_counting() {
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        run(&mut ring, 48_000, 480, |_, r| r.push_interleaved(&sine.chunk(480)));
        ring.reset();
        assert_eq!(ring.fill(), 0);
        run(&mut ring, 48_000, 480, |_, r| r.push_interleaved(&sine.chunk(480)));
        let s = ring.stats();
        assert_eq!((s.underruns, s.gaps), (0, 0));
    }

    #[test]
    fn target_shrinks_after_20s_without_dropouts() {
        let mut ring = AdaptiveRing::new(FS, FS, 60.0, 40.0);
        let mut sine = Sine { phase: 0.0, freq: 440.0, rate: FS };
        // force one dropout to grow the target
        run(&mut ring, 48_000 * 2, 480, |step, r| {
            if (50..60).contains(&step) {
                return;
            }
            if step == 60 {
                r.push_interleaved(&sine.chunk(480 * 11));
            } else {
                r.push_interleaved(&sine.chunk(480));
            }
        });
        assert_eq!(ring.stats().target_ms, 90);
        run(&mut ring, 48_000 * 45, 480, |_, r| r.push_interleaved(&sine.chunk(480)));
        assert!(ring.stats().target_ms < 90 && ring.stats().target_ms >= 40, "{:?}", ring.stats());
    }
}
