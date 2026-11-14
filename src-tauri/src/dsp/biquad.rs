//! Biquad filters with the same coefficient formulas as Web Audio's BiquadFilterNode
//! (Audio EQ Cookbook, shelf slope S = 1), so the 3-band master EQ sounds like the
//! Electron build: low shelf 180 Hz, peaking 1.4 kHz (Q 0.9), high shelf 5.6 kHz.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    LowShelf,
    Peaking { q: f64 },
    HighShelf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefs {
    pub const IDENTITY: Coefs = Coefs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    pub fn design(kind: Kind, freq_hz: f64, gain_db: f64, sample_rate: f64) -> Coefs {
        if gain_db.abs() < 1e-6 {
            return Coefs::IDENTITY;
        }
        let w0 = 2.0 * PI * (freq_hz / sample_rate).clamp(1e-6, 0.4999);
        let a = 10f64.powf(gain_db / 40.0);
        let k = w0.cos();
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::LowShelf => {
                let alpha = 0.5 * w0.sin() * 2f64.sqrt();
                let k2 = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * k + k2),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * k),
                    a * ((a + 1.0) - (a - 1.0) * k - k2),
                    (a + 1.0) + (a - 1.0) * k + k2,
                    -2.0 * ((a - 1.0) + (a + 1.0) * k),
                    (a + 1.0) + (a - 1.0) * k - k2,
                )
            }
            Kind::HighShelf => {
                let alpha = 0.5 * w0.sin() * 2f64.sqrt();
                let k2 = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * k + k2),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * k),
                    a * ((a + 1.0) + (a - 1.0) * k - k2),
                    (a + 1.0) - (a - 1.0) * k + k2,
                    2.0 * ((a - 1.0) - (a + 1.0) * k),
                    (a + 1.0) - (a - 1.0) * k - k2,
                )
            }
            Kind::Peaking { q } => {
                let alpha = w0.sin() / (2.0 * q.max(1e-3));
                (1.0 + alpha * a, -2.0 * k, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * k, 1.0 - alpha / a)
            }
        };
        Coefs { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// Magnitude response in dB at `freq_hz` (used by the tests).
    pub fn magnitude_db(&self, freq_hz: f64, sample_rate: f64) -> f64 {
        let w = 2.0 * PI * freq_hz / sample_rate;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let num_re = self.b0 + self.b1 * c1 + self.b2 * c2;
        let num_im = -(self.b1 * s1 + self.b2 * s2);
        let den_re = 1.0 + self.a1 * c1 + self.a2 * c2;
        let den_im = -(self.a1 * s1 + self.a2 * s2);
        let num = (num_re * num_re + num_im * num_im).sqrt();
        let den = (den_re * den_re + den_im * den_im).sqrt();
        20.0 * (num / den).log10()
    }
}

/// Transposed direct form II, f64 state (stable at low frequencies and high gains).
#[derive(Clone, Debug, Default)]
pub struct Biquad {
    c: Option<Coefs>,
    z1: f64,
    z2: f64,
}

impl Biquad {
    pub fn set(&mut self, c: Coefs) {
        self.c = if c == Coefs::IDENTITY { None } else { Some(c) };
        if self.c.is_none() {
            self.z1 = 0.0;
            self.z2 = 0.0;
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let Some(c) = self.c else { return x };
        let x = x as f64;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        // flush denormals
        if self.z1.abs() < 1e-30 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-30 {
            self.z2 = 0.0;
        }
        y as f32
    }
}

/// Master EQ band layout (matches the Electron build).
pub const EQ_BANDS: [(Kind, f64); 3] = [
    (Kind::LowShelf, 180.0),
    (Kind::Peaking { q: 0.9 }, 1400.0),
    (Kind::HighShelf, 5600.0),
];

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48_000.0;

    #[test]
    fn zero_gain_is_identity() {
        for (kind, f) in EQ_BANDS {
            assert_eq!(Coefs::design(kind, f, 0.0, FS), Coefs::IDENTITY);
        }
        let mut b = Biquad::default();
        b.set(Coefs::IDENTITY);
        assert_eq!(b.process(0.25), 0.25);
    }

    #[test]
    fn shelves_and_peak_hit_their_gain() {
        let low = Coefs::design(Kind::LowShelf, 180.0, 6.0, FS);
        assert!((low.magnitude_db(20.0, FS) - 6.0).abs() < 0.3);
        assert!(low.magnitude_db(10_000.0, FS).abs() < 0.1);
        assert!((low.magnitude_db(180.0, FS) - 3.0).abs() < 0.3, "half gain at the corner");

        let high = Coefs::design(Kind::HighShelf, 5600.0, -6.0, FS);
        assert!((high.magnitude_db(20_000.0, FS) + 6.0).abs() < 0.4);
        assert!(high.magnitude_db(100.0, FS).abs() < 0.1);

        let mid = Coefs::design(Kind::Peaking { q: 0.9 }, 1400.0, 4.0, FS);
        assert!((mid.magnitude_db(1400.0, FS) - 4.0).abs() < 0.05);
        assert!(mid.magnitude_db(20.0, FS).abs() < 0.2);
    }

    #[test]
    fn filter_matches_designed_response() {
        // Run a 1 kHz sine through a +6 dB peak at 1 kHz and measure the steady-state level.
        let c = Coefs::design(Kind::Peaking { q: 0.9 }, 1000.0, 6.0, FS);
        let mut b = Biquad::default();
        b.set(c);
        let mut peak = 0f32;
        for i in 0..48_000 {
            let x = (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / FS).sin() as f32 * 0.25;
            let y = b.process(x);
            if i > 24_000 {
                peak = peak.max(y.abs());
            }
        }
        let gain_db = 20.0 * (peak / 0.25).log10();
        assert!((gain_db - 6.0).abs() < 0.1, "{gain_db}");
    }
}
