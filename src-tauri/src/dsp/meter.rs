//! Level accumulation for meters. The audio thread adds samples; the meter thread takes a
//! snapshot about 30 times a second (peak + RMS over the window).

#[derive(Clone, Copy, Debug, Default)]
pub struct LevelAccum {
    pub peak: f32,
    pub sum_sq: f64,
    pub count: u32,
}

impl LevelAccum {
    #[inline]
    pub fn add(&mut self, l: f32, r: f32) {
        let p = l.abs().max(r.abs());
        if p > self.peak {
            self.peak = p;
        }
        self.sum_sq += (l as f64 * l as f64 + r as f64 * r as f64) * 0.5;
        self.count += 1;
    }

    pub fn merge(&mut self, other: &LevelAccum) {
        self.peak = self.peak.max(other.peak);
        self.sum_sq += other.sum_sq;
        self.count += other.count;
    }

    /// (peak dB, rms dB); `-inf` for silence.
    pub fn levels_db(&self) -> (f32, f32) {
        let peak = super::gain_to_db(self.peak);
        let rms = if self.count == 0 { 0.0 } else { (self.sum_sq / self.count as f64).sqrt() as f32 };
        (peak, super::gain_to_db(rms))
    }

    pub fn take(&mut self) -> LevelAccum {
        std::mem::take(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sine_levels() {
        let mut a = LevelAccum::default();
        for i in 0..48_000 {
            let x = (i as f32 * 0.1).sin() * 0.5;
            a.add(x, x);
        }
        let (peak, rms) = a.levels_db();
        assert!((peak - (-6.02)).abs() < 0.05, "{peak}");
        assert!((rms - (-9.03)).abs() < 0.05, "{rms}");
        let taken = a.take();
        assert_eq!(taken.count, 48_000);
        assert_eq!(a.levels_db().0, f32::NEG_INFINITY);
    }
}
