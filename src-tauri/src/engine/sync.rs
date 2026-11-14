//! Karaoke sync: line up app audio (the backing track) with live mics and lines on the
//! MIX bus, without adding latency to what the singer hears.
//!
//! The model. Pick a moment E when the singer hears a bit of the song in their headphones
//! and sings along with it. In the mixer's own timeline:
//!  - the song bit was mixed at E - heard, where `heard` is the time from the mixer to the
//!    singer's ears (the monitor bus output: device buffer, plus the secondary output buffer
//!    when that bus is not the clock master);
//!  - the voice reaches the mixer at E + input, where `input` is the mic capture time plus
//!    its jitter buffer.
//! So on MIX the voice trails the music by heard + input. Each live strip gets an
//! "arrival" time relative to E (apps: -heard, devices: +input) and every strip sent to MIX
//! is delayed by (latest arrival - its arrival). The slowest source gets no delay, so the
//! music is held back on MIX only. Monitor buses never get any delay: the singer still hears
//! the music and their own voice as early as possible.
//!
//! When an app is not sent to a monitor bus the singer hears it straight from Windows, so
//! `heard` is the Windows output time minus the app's own capture path (it can be negative:
//! the mixer gets the song after the singer already heard it, and then the mic is delayed).
//!
//! Every strip also has a manual offset (ms, may be negative) added on top, for things the
//! engine cannot measure (Bluetooth headphones, DAC latency, reaction habits). After adding
//! offsets everything is shifted so the smallest delay is 0.

/// The bus that gets aligned (MIX).
pub const ALIGN_BUS: usize = 2;
/// Buses the singer may listen on (MON 1, MON 2), in order of preference.
pub const MONITOR_BUSES: [usize; 2] = [0, 1];
/// Longest delay applied to a strip.
pub const MAX_DELAY_MS: f64 = 1000.0;
/// Manual offset range.
pub const MIN_OFFSET_MS: f64 = -250.0;
pub const MAX_OFFSET_MS: f64 = 500.0;
/// WASAPI shared-mode capture hands audio over in device periods (about 10 ms).
pub const DEVICE_CAPTURE_MS: f64 = 10.0;
/// Process loopback delivers about 10 ms packets too.
pub const APP_CAPTURE_MS: f64 = 10.0;
/// Rough time from an app to the speakers when Windows plays it directly.
pub const WINDOWS_RENDER_MS: f64 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SourceKind {
    /// A capture endpoint: microphone, line in, virtual cable.
    #[default]
    Device,
    /// Process loopback of an application.
    App,
}

/// One strip that is live on the aligned bus.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncStrip {
    pub kind: SourceKind,
    /// Capture + jitter buffer: from the sound happening to it reaching the mixer.
    pub input_ms: f64,
    /// Apps only: mixer to the singer's ears through a monitor bus. None = the app is not on
    /// a monitor bus, so the singer hears it straight from Windows.
    pub heard_ms: Option<f64>,
    /// Manual offset (ms), added to this strip's delay on MIX.
    pub offset_ms: f64,
}

/// Where the strip's content lands in the mixer timeline, relative to the moment the singer
/// hears the music.
pub fn arrival_ms(s: &SyncStrip) -> f64 {
    match s.kind {
        SourceKind::Device => s.input_ms,
        SourceKind::App => match s.heard_ms {
            Some(heard) => -heard,
            None => s.input_ms - WINDOWS_RENDER_MS,
        },
    }
}

/// Auto alignment only makes sense when someone sings over something: at least one app and
/// one device strip live on MIX.
pub fn auto_applies(strips: &[Option<SyncStrip>]) -> bool {
    let live = || strips.iter().flatten();
    live().any(|s| s.kind == SourceKind::App) && live().any(|s| s.kind == SourceKind::Device)
}

/// Delay (ms) for every strip on the aligned bus. `None` = strip not live on that bus (0).
pub fn align(strips: &[Option<SyncStrip>], auto: bool) -> Vec<f64> {
    let use_auto = auto && auto_applies(strips);
    let latest = strips.iter().flatten().map(arrival_ms).fold(f64::NEG_INFINITY, f64::max);
    let raw: Vec<Option<f64>> = strips
        .iter()
        .map(|s| {
            s.map(|s| {
                let auto_part = if use_auto { latest - arrival_ms(&s) } else { 0.0 };
                let offset = if s.offset_ms.is_finite() { s.offset_ms.clamp(MIN_OFFSET_MS, MAX_OFFSET_MS) } else { 0.0 };
                auto_part + offset
            })
        })
        .collect();
    let min = raw.iter().flatten().copied().fold(f64::INFINITY, f64::min);
    raw.iter()
        .map(|d| match d {
            Some(d) => (d - min).clamp(0.0, MAX_DELAY_MS),
            None => 0.0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mic(input_ms: f64) -> Option<SyncStrip> {
        Some(SyncStrip { kind: SourceKind::Device, input_ms, heard_ms: None, offset_ms: 0.0 })
    }
    fn app(input_ms: f64, heard_ms: Option<f64>) -> Option<SyncStrip> {
        Some(SyncStrip { kind: SourceKind::App, input_ms, heard_ms, offset_ms: 0.0 })
    }
    fn close(a: &[f64], b: &[f64]) {
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 1e-9, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn music_on_mix_waits_for_headphones_plus_mic() {
        // Spotify heard on MON 1 after 25 ms, mic arrives 20 ms after the singer sings:
        // the music is held back 45 ms on MIX, the mic is not delayed.
        let d = align(&[mic(20.0), app(30.0, Some(25.0)), None], true);
        close(&d, &[0.0, 45.0, 0.0]);
    }

    #[test]
    fn app_input_latency_does_not_matter_when_heard_through_the_mixer() {
        let a = align(&[mic(20.0), app(20.0, Some(25.0))], true);
        let b = align(&[mic(20.0), app(100.0, Some(25.0))], true);
        close(&a, &b);
    }

    #[test]
    fn heard_straight_from_windows_can_delay_the_mic_instead() {
        // App not on a monitor bus: heard 20 ms after loopback, but reaches the mixer after
        // 10 + 60 ms. Music arrival = 70 - 20 = 50, mic = 20: mic delayed 30 ms.
        let d = align(&[mic(20.0), app(70.0, None)], true);
        close(&d, &[30.0, 0.0]);
    }

    #[test]
    fn auto_needs_both_an_app_and_a_mic() {
        close(&align(&[app(30.0, Some(25.0)), app(70.0, Some(60.0))], true), &[0.0, 0.0]);
        close(&align(&[mic(20.0), mic(50.0)], true), &[0.0, 0.0]);
        close(&align(&[mic(20.0), app(30.0, Some(25.0))], false), &[0.0, 0.0]);
    }

    #[test]
    fn two_mics_both_line_up_with_the_music() {
        // Each strip is aligned to the latest arrival, so both voices meet the music.
        let d = align(&[mic(20.0), mic(50.0), app(30.0, Some(25.0))], true);
        close(&d, &[30.0, 0.0, 75.0]);
    }

    #[test]
    fn manual_offsets_add_and_negative_ones_shift_the_others() {
        let mut m = mic(20.0);
        // mic +10 ms: it plays 10 ms later relative to the music, so the music needs 10 less
        m.as_mut().unwrap().offset_ms = 10.0;
        close(&align(&[m, app(30.0, Some(25.0))], true), &[0.0, 35.0]);
        // mic -60 ms: it cannot play early, so everything else is held back 60 ms more
        m.as_mut().unwrap().offset_ms = -60.0;
        close(&align(&[m, app(30.0, Some(25.0))], true), &[0.0, 105.0]);
        // offsets also work with auto off
        let mut a = app(30.0, Some(25.0));
        a.as_mut().unwrap().offset_ms = 40.0;
        close(&align(&[mic(20.0), a], false), &[0.0, 40.0]);
    }

    #[test]
    fn delays_are_clamped() {
        let mut a = app(30.0, Some(25.0));
        a.as_mut().unwrap().offset_ms = 1e9;
        let d = align(&[mic(20.0), a], true);
        assert!(d[1] <= MAX_DELAY_MS);
        let mut b = app(30.0, Some(25.0));
        b.as_mut().unwrap().offset_ms = f64::NAN;
        close(&align(&[mic(20.0), b], true), &[0.0, 45.0]);
    }

    #[test]
    fn empty_and_single_strip_get_no_delay() {
        assert!(align(&[], true).is_empty());
        close(&align(&[None, None], true), &[0.0, 0.0]);
        let mut a = app(30.0, Some(25.0));
        a.as_mut().unwrap().offset_ms = 80.0;
        close(&align(&[a], true), &[0.0]);
    }
}
