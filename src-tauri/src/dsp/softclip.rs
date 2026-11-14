//! Soft clipper: unity below the knee threshold, tanh knee above it, asymptotic to 0 dBFS.
//! Same curve as the Electron build. Instead of a 4x oversampled WaveShaper it uses
//! first-order antiderivative anti-aliasing (ADAA), which suppresses most of the aliasing a
//! hard knee would add at a fraction of the cost of oversampling.

/// Knee threshold in linear terms, clamped like the Electron build.
pub fn threshold_from_db(threshold_db: f32) -> f32 {
    10f32.powf(threshold_db / 20.0).clamp(0.05, 0.99)
}

/// The static curve f(x).
#[inline]
pub fn soft_clip_sample(x: f32, threshold: f32) -> f32 {
    let headroom = 1.0 - threshold;
    let m = x.abs();
    if m <= threshold {
        x
    } else {
        x.signum() * (threshold + headroom * ((m - threshold) / headroom).tanh())
    }
}

/// Antiderivative F(x) of the curve (even function).
#[inline]
fn antiderivative(x: f64, t: f64) -> f64 {
    let h = 1.0 - t;
    let m = x.abs();
    if m <= t {
        0.5 * x * x
    } else {
        let u = (m - t) / h;
        // ln(cosh(u)) computed without overflow for large u
        let ln_cosh = if u > 20.0 { u - std::f64::consts::LN_2 } else { u.cosh().ln() };
        0.5 * t * t + t * (m - t) + h * h * ln_cosh
    }
}

#[derive(Clone, Debug)]
pub struct SoftClipper {
    threshold: f32,
    prev_x: f64,
    prev_f: f64,
}

impl SoftClipper {
    pub fn new(threshold_db: f32) -> Self {
        let threshold = threshold_from_db(threshold_db);
        Self { threshold, prev_x: 0.0, prev_f: 0.0 }
    }

    pub fn set_threshold_db(&mut self, threshold_db: f32) {
        let t = threshold_from_db(threshold_db);
        if t != self.threshold {
            self.threshold = t;
            self.prev_f = antiderivative(self.prev_x, t as f64);
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let t = self.threshold as f64;
        let xd = x as f64;
        let f = antiderivative(xd, t);
        let dx = xd - self.prev_x;
        let y = if dx.abs() < 1e-5 {
            soft_clip_sample(((xd + self.prev_x) * 0.5) as f32, self.threshold) as f64
        } else {
            (f - self.prev_f) / dx
        };
        self.prev_x = xd;
        self.prev_f = f;
        y as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unity_below_threshold_and_bounded_above() {
        let t = threshold_from_db(-6.0);
        assert_eq!(soft_clip_sample(0.3, t), 0.3);
        assert_eq!(soft_clip_sample(-0.3, t), -0.3);
        for x in [0.6f32, 1.0, 2.0, 8.0, 100.0] {
            let y = soft_clip_sample(x, t);
            assert!(y > t && y <= 1.0, "{x} -> {y}");
            assert_eq!(soft_clip_sample(-x, t), -y, "odd symmetry");
        }
        // monotonic
        let mut last = -1.0;
        for i in 0..2000 {
            let y = soft_clip_sample(i as f32 / 200.0, t);
            assert!(y >= last);
            last = y;
        }
    }

    #[test]
    fn adaa_tracks_static_curve_for_slow_signals() {
        let mut c = SoftClipper::new(-6.0);
        let t = threshold_from_db(-6.0);
        // A slow ramp: ADAA output equals the curve at the midpoint of consecutive samples.
        let mut prev = 0.0f32;
        for i in 0..4000 {
            let x = i as f32 / 1000.0;
            let y = c.process(x);
            let expected = soft_clip_sample((x + prev) * 0.5, t);
            assert!((y - expected).abs() < 2e-3, "{x}: {y} vs {expected}");
            prev = x;
        }
    }

    #[test]
    fn output_never_exceeds_full_scale_even_with_heavy_drive() {
        let mut c = SoftClipper::new(-6.0);
        for i in 0..48_000 {
            let x = (i as f32 * 0.37).sin() * 16.0; // +24 dB of drive, harsh signal
            let y = c.process(x);
            assert!(y.abs() <= 1.0 + 1e-6, "{y}");
        }
    }
}
