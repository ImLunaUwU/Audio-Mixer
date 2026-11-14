//! Demo backend: fake devices and apps that produce test tones, and null outputs paced by a
//! timer. Used on non-Windows builds and in tests, so the engine and UI run anywhere.

use crate::engine::backend::{AppInfo, Backend, CaptureFeed, CaptureHandle, CaptureSpec, DeviceInfo, RenderStream};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub struct DemoBackend;

impl DemoBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DemoBackend {
    fn default() -> Self {
        Self::new()
    }
}

const DEVICES: &[(&str, &str, &str, bool)] = &[
    ("{0.0.1.00000000}.{demo-mic}", "Microphone (Demo USB Mic)", "capture", true),
    ("{0.0.1.00000000}.{demo-line1}", "Line 1 (Virtual Audio Cable)", "capture", false),
    ("{0.0.0.00000000}.{demo-headphones}", "Headphones (Demo Audio)", "render", true),
    ("{0.0.0.00000000}.{demo-speakers}", "Speakers (Demo Audio)", "render", false),
    ("{0.0.0.00000000}.{demo-line1}", "Line 1 (Virtual Audio Cable)", "render", false),
    ("{0.0.0.00000000}.{demo-steam}", "Speakers (Steam Streaming Speakers)", "render", false),
];

impl Backend for DemoBackend {
    fn name(&self) -> &'static str {
        "demo"
    }

    fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        Ok(DEVICES
            .iter()
            .map(|(id, name, flow, def)| DeviceInfo { id: id.to_string(), name: name.to_string(), flow, channels: 2, is_default: *def })
            .collect())
    }

    fn apps_supported(&self) -> bool {
        true
    }

    fn list_apps(&self, _exclude: &[u32]) -> Vec<AppInfo> {
        vec![
            AppInfo { pid: 4242, exe_name: "Spotify.exe".into(), title: "Spotify Premium".into() },
            AppInfo { pid: 5151, exe_name: "Discord.exe".into(), title: "Discord".into() },
        ]
    }

    fn open_capture(&self, spec: &CaptureSpec, _buffer_ms: u32, feed: CaptureFeed) -> Result<CaptureHandle, String> {
        let (freq, gaps) = match spec {
            CaptureSpec::Device(id) => {
                if !DEVICES.iter().any(|d| d.0 == id && d.2 == "capture") {
                    return Err("device not found".into());
                }
                (if id.contains("mic") { 440.0 } else { 220.0 }, false)
            }
            CaptureSpec::App(pid) => match pid {
                4242 => (330.0, true),
                5151 => (550.0, false),
                _ => return Err("process not found".into()),
            },
        };
        let stop = feed.stop.clone();
        let alive = feed.alive.clone();
        let thread = std::thread::Builder::new()
            .name("demo-capture".into())
            .spawn(move || {
                let CaptureFeed { mut producer, stop, alive, .. } = feed;
                let start = Instant::now();
                let mut produced: u64 = 0;
                let mut phase = 0f64;
                while !stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(10));
                    let due = (start.elapsed().as_secs_f64() * 48_000.0) as u64;
                    let n = due - produced;
                    produced = due;
                    // the "app" goes quiet for 1 s every 6 s (process loopback sends nothing)
                    let t = start.elapsed().as_secs_f64();
                    if gaps && (t % 6.0) > 5.0 {
                        continue;
                    }
                    // slow tremolo so meters move
                    let amp = 0.25 + 0.2 * (t * 1.3).sin();
                    for _ in 0..n {
                        let s = ((phase * std::f64::consts::TAU).sin() * amp) as f32;
                        phase = (phase + freq / 48_000.0) % 1.0;
                        let _ = producer.push(s);
                        let _ = producer.push(s);
                    }
                }
                alive.store(false, Ordering::Release);
            })
            .map_err(|e| e.to_string())?;
        Ok(CaptureHandle { stop, alive, thread: Some(thread) })
    }

    fn open_render(&self, device_id: &str, buffer_ms: u32) -> Result<Box<dyn RenderStream>, String> {
        if !DEVICES.iter().any(|d| d.0 == device_id && d.2 == "render") {
            return Err("device not found".into());
        }
        Ok(Box::new(NullRender { start: Instant::now(), done: 0, period: Duration::from_millis(buffer_ms.clamp(5, 40) as u64 / 2) }))
    }
}

struct NullRender {
    start: Instant,
    done: u64,
    period: Duration,
}

impl RenderStream for NullRender {
    fn rate(&self) -> f64 {
        48_000.0
    }

    fn wait_frames(&mut self, _timeout_ms: u32) -> Result<usize, String> {
        std::thread::sleep(self.period);
        let due = (self.start.elapsed().as_secs_f64() * 48_000.0) as u64;
        let n = due.saturating_sub(self.done).min(8192);
        self.done += n;
        Ok(n as usize)
    }

    fn write(&mut self, _interleaved: &[f32]) -> Result<(), String> {
        Ok(())
    }
}
