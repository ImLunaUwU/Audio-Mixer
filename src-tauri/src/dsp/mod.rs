//! Pure DSP building blocks for the mixer engine. Nothing here touches an OS API, so every
//! piece is unit-tested on any platform (`cargo test`).

pub mod biquad;
pub mod delay;
pub mod jitter;
pub mod limiter;
pub mod meter;
pub mod softclip;

/// Faders and sends treat anything at or below this as silence (-inf).
pub const MIN_DB: f32 = -60.0;
/// Largest input trim (dB).
pub const MAX_INPUT_DB: f32 = 24.0;
/// Largest bus fader (dB).
pub const MAX_BUS_DB: f32 = 12.0;

/// dB to linear gain. At or below [`MIN_DB`] (and for NaN) the result is 0 (silence).
pub fn db_to_gain(db: f32) -> f32 {
    if !db.is_finite() || db <= MIN_DB {
        return 0.0;
    }
    10f32.powf(db / 20.0)
}

/// Linear gain to dB. Zero or negative gain is `-inf`.
pub fn gain_to_db(gain: f32) -> f32 {
    if gain > 0.0 {
        20.0 * gain.log10()
    } else {
        f32::NEG_INFINITY
    }
}

/// One-pole parameter smoother (the Web Audio build used `setTargetAtTime` with a 15 ms time
/// constant). Avoids zipper noise on every fader, send, mute and mono change.
#[derive(Clone, Debug)]
pub struct Smoother {
    // f64 state: in f32 the last few 1e-5 never converge (each step rounds back).
    value: f64,
    target: f64,
    coef: f64,
}

impl Smoother {
    pub const DEFAULT_TC: f32 = 0.015;

    pub fn new(initial: f32, time_constant_s: f32, sample_rate: f32) -> Self {
        let coef = (-1.0 / (time_constant_s.max(1e-4) as f64 * sample_rate as f64)).exp();
        Self { value: initial as f64, target: initial as f64, coef }
    }

    pub fn set_target(&mut self, target: f32) {
        self.target = if target.is_finite() { target as f64 } else { 0.0 };
    }

    pub fn target(&self) -> f32 {
        self.target as f32
    }

    pub fn value(&self) -> f32 {
        self.value as f32
    }

    /// Jump straight to the target (used when a strip is first connected).
    pub fn snap(&mut self) {
        self.value = self.target;
    }

    pub fn is_settled(&self) -> bool {
        self.value == self.target
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.value != self.target {
            self.value = self.target + (self.value - self.target) * self.coef;
            if (self.value - self.target).abs() < 1e-9 {
                self.value = self.target;
            }
        }
        self.value as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_gain_round_trip() {
        assert_eq!(db_to_gain(0.0), 1.0);
        assert!((db_to_gain(-6.0) - 0.501_187).abs() < 1e-5);
        assert!((db_to_gain(24.0) - 15.848_93).abs() < 1e-3);
        assert!((db_to_gain(12.0) - 3.981_07).abs() < 1e-4);
        assert_eq!(db_to_gain(MIN_DB), 0.0);
        assert_eq!(db_to_gain(-100.0), 0.0);
        assert_eq!(db_to_gain(f32::NAN), 0.0);
        for db in [-59.0f32, -24.0, -3.0, 0.0, 6.0, 18.0, 24.0] {
            assert!((gain_to_db(db_to_gain(db)) - db).abs() < 1e-3, "{db}");
        }
        assert_eq!(gain_to_db(0.0), f32::NEG_INFINITY);
    }

    #[test]
    fn smoother_settles_without_overshoot() {
        let rate = 48_000.0;
        let mut s = Smoother::new(0.0, Smoother::DEFAULT_TC, rate);
        s.set_target(1.0);
        let mut last = 0.0;
        // after one time constant ~63 %, after 5 time constants > 99 %
        for i in 0..(rate as usize) {
            let v = s.next();
            assert!(v >= last && v <= 1.0, "monotonic and bounded");
            last = v;
            if i == (0.015 * rate) as usize {
                assert!((v - 0.632).abs() < 0.01, "one time constant: {v}");
            }
        }
        assert!(s.is_settled(), "{} {}", s.value(), s.target());
    }
}
