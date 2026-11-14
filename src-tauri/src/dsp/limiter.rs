//! Lookahead brickwall peak limiter (port of the Electron build's AudioWorklet).
//!
//! The signal is delayed by the lookahead window while the gain computer looks at the future
//! peak, so the gain is already down when the peak arrives (no overshoot, no hard clipping).
//! Attack is a linear ramp guaranteed to reach the required gain within the lookahead, release
//! is exponential. A final clamp catches residue. Stereo linked.

#[derive(Clone, Debug)]
pub struct Limiter {
    look: usize,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    pos: usize,
    gain: f32,
    // sliding-window minimum: monotonic deque over the last `look + 1` required gains
    dq_idx: Vec<u64>,
    dq_val: Vec<f32>,
    head: usize,
    tail: usize,
    counter: u64,
    rel_coef: f32,
    pub enabled: bool,
    pub ceiling: f32,
    min_gr_db: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32, lookahead_s: f32, release_s: f32) -> Self {
        let look = ((sample_rate * lookahead_s).round() as usize).max(1);
        let cap = look + 2;
        Self {
            look,
            delay_l: vec![0.0; look],
            delay_r: vec![0.0; look],
            pos: 0,
            gain: 1.0,
            dq_idx: vec![0; cap],
            dq_val: vec![0.0; cap],
            head: 0,
            tail: 0,
            counter: 0,
            rel_coef: (-1.0 / (sample_rate * release_s)).exp(),
            enabled: true,
            ceiling: 10f32.powf(-1.0 / 20.0),
            min_gr_db: 0.0,
        }
    }

    /// Latency in samples.
    pub fn latency(&self) -> usize {
        self.look
    }

    pub fn set_ceiling_db(&mut self, db: f32) {
        self.ceiling = 10f32.powf(db.clamp(-40.0, 0.0) / 20.0);
    }

    fn push_min(&mut self, value: f32) -> f32 {
        let cap = self.look + 2;
        while self.tail != self.head {
            let last = (self.tail + cap - 1) % cap;
            if self.dq_val[last] >= value {
                self.tail = last;
            } else {
                break;
            }
        }
        self.dq_idx[self.tail] = self.counter;
        self.dq_val[self.tail] = value;
        self.tail = (self.tail + 1) % cap;
        while self.dq_idx[self.head] + (self.look as u64) < self.counter {
            self.head = (self.head + 1) % cap;
        }
        self.counter += 1;
        self.dq_val[self.head]
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let ceiling = self.ceiling;
        let peak = l.abs().max(r.abs());
        let required = if self.enabled && peak > ceiling { ceiling / peak } else { 1.0 };
        let target = self.push_min(required);
        if target < self.gain {
            let step = (1.0 - target) / self.look as f32;
            self.gain = (self.gain - step).max(target);
        } else {
            self.gain = target + (self.gain - target) * self.rel_coef;
        }
        let dl = self.delay_l[self.pos];
        let dr = self.delay_r[self.pos];
        self.delay_l[self.pos] = l;
        self.delay_r[self.pos] = r;
        self.pos = (self.pos + 1) % self.look;
        let mut ol = dl * self.gain;
        let mut or = dr * self.gain;
        if self.enabled {
            ol = ol.clamp(-ceiling, ceiling);
            or = or.clamp(-ceiling, ceiling);
        }
        if self.gain < 1.0 {
            let gr = 20.0 * self.gain.log10();
            if gr < self.min_gr_db {
                self.min_gr_db = gr;
            }
        }
        (ol, or)
    }

    /// Deepest gain reduction (dB, <= 0) since the last call.
    pub fn take_min_gr_db(&mut self) -> f32 {
        std::mem::replace(&mut self.min_gr_db, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 48_000.0;

    fn ceiling(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    #[test]
    fn transparent_below_ceiling() {
        let mut lim = Limiter::new(FS, 0.003, 0.08);
        lim.set_ceiling_db(-1.0);
        let input: Vec<f32> = (0..4800).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        let out: Vec<f32> = input.iter().map(|&x| lim.process(x, x).0).collect();
        let d = lim.latency();
        for i in d..input.len() {
            assert!((out[i] - input[i - d]).abs() < 1e-6);
        }
        assert_eq!(lim.take_min_gr_db(), 0.0);
    }

    #[test]
    fn never_exceeds_ceiling_at_minus_one_db() {
        let mut lim = Limiter::new(FS, 0.003, 0.08);
        lim.set_ceiling_db(-1.0);
        let c = ceiling(-1.0);
        let mut max = 0f32;
        for i in 0..96_000 {
            // loud sine with +12 dB bursts
            let burst = if (i / 4800) % 2 == 0 { 4.0 } else { 0.8 };
            let x = (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / FS).sin() * burst;
            let (l, r) = lim.process(x, -x * 0.5);
            max = max.max(l.abs()).max(r.abs());
        }
        assert!(max <= c + 1e-6, "{max} > {c}");
        assert!(lim.take_min_gr_db() < -10.0, "reports gain reduction");
    }

    #[test]
    fn gain_is_down_before_the_peak_arrives() {
        // A single full-scale spike after silence must come out at the ceiling without the
        // final clamp doing the work (the lookahead ramp already reached the gain).
        let mut lim = Limiter::new(FS, 0.003, 0.08);
        lim.set_ceiling_db(-1.0);
        let c = ceiling(-1.0);
        let mut out = Vec::new();
        for i in 0..1000 {
            let x = if i == 500 { 2.0 } else { 0.0 };
            out.push(lim.process(x, x).0);
        }
        let spike = out[500 + lim.latency()];
        assert!((spike - c).abs() < 1e-4, "{spike}");
    }

    #[test]
    fn disabled_passes_everything() {
        let mut lim = Limiter::new(FS, 0.003, 0.08);
        lim.enabled = false;
        let d = lim.latency();
        let mut out = Vec::new();
        for i in 0..200 {
            out.push(lim.process(if i == 10 { 3.0 } else { 0.0 }, 0.0).0);
        }
        assert_eq!(out[10 + d], 3.0);
    }
}
