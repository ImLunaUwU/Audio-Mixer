//! Stereo delay line with click-free delay changes (used for the karaoke sync on MIX).
//!
//! Always written, so switching a delay on has history to read from. A change of delay
//! crossfades from the old read tap to the new one over 10 ms instead of jumping.
//! Never allocates after construction.

const XFADE: usize = 480; // 10 ms at 48 kHz

#[derive(Clone, Debug)]
pub struct DelayLine {
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    delay: usize,
    old_delay: usize,
    xfade: usize,
}

impl DelayLine {
    /// `max_frames`: longest delay supported.
    pub fn new(max_frames: usize) -> Self {
        let cap = max_frames + 1;
        Self { left: vec![0.0; cap], right: vec![0.0; cap], write: 0, delay: 0, old_delay: 0, xfade: 0 }
    }

    pub fn max_delay(&self) -> usize {
        self.left.len() - 1
    }

    pub fn delay(&self) -> usize {
        self.delay
    }

    /// Set the delay in frames (clamped to the maximum). Crossfades when it changes.
    pub fn set_delay(&mut self, frames: usize) {
        let frames = frames.min(self.max_delay());
        if frames == self.delay {
            return;
        }
        self.old_delay = self.delay;
        self.delay = frames;
        self.xfade = XFADE;
    }

    #[inline]
    fn tap(&self, d: usize) -> (f32, f32) {
        let cap = self.left.len();
        let i = (self.write + cap - d) % cap;
        (self.left[i], self.right[i])
    }

    /// Push one frame and return the delayed frame.
    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let cap = self.left.len();
        self.left[self.write] = l;
        self.right[self.write] = r;
        let (mut ol, mut or) = self.tap(self.delay);
        if self.xfade > 0 {
            let t = self.xfade as f32 / XFADE as f32;
            let (pl, pr) = self.tap(self.old_delay);
            ol = ol * (1.0 - t) + pl * t;
            or = or * (1.0 - t) + pr * t;
            self.xfade -= 1;
        }
        self.write = (self.write + 1) % cap;
        (ol, or)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_delay_is_transparent() {
        let mut d = DelayLine::new(100);
        for i in 0..50 {
            let x = i as f32;
            assert_eq!(d.process(x, -x), (x, -x));
        }
    }

    #[test]
    fn delays_by_the_requested_frames() {
        let mut d = DelayLine::new(1000);
        d.set_delay(480);
        let mut out = Vec::new();
        for i in 0..2000 {
            out.push(d.process(i as f32, 0.0).0);
        }
        // after the crossfade, output is the input 480 frames ago
        for i in 1000..2000 {
            assert_eq!(out[i], (i - 480) as f32);
        }
    }

    #[test]
    fn change_is_smooth_and_clamped() {
        let mut d = DelayLine::new(2000);
        let mut prev = 0.0f32;
        let mut max_jump = 0f32;
        for i in 0..6000 {
            if i == 1000 {
                d.set_delay(960);
            }
            let x = (i as f32 * 2.0 * std::f32::consts::PI * 100.0 / 48_000.0).sin();
            let y = d.process(x, x).0;
            if i > 0 {
                max_jump = max_jump.max((y - prev).abs());
            }
            prev = y;
        }
        // a 100 Hz sine moves at most ~0.013 per sample; a hard jump would be ~1
        assert!(max_jump < 0.05, "{max_jump}");
        d.set_delay(10_000);
        assert_eq!(d.delay(), 2000);
    }
}
