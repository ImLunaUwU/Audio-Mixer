//! Platform audio backend interface. The Windows build uses WASAPI (`platform::windows`);
//! other platforms get a demo backend (test tones, null outputs) so the UI and the engine
//! can be developed and tested anywhere.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Windows endpoint id ("{0.0.0.00000000}.{guid}").
    pub id: String,
    pub name: String,
    /// "capture" or "render".
    pub flow: &'static str,
    pub channels: u16,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub pid: u32,
    pub exe_name: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureSpec {
    /// A capture endpoint (microphone, line in, virtual cable output...).
    Device(String),
    /// WASAPI process loopback of a process and its children.
    App(u32),
}

impl CaptureSpec {
    pub fn parse(source_id: &str) -> Option<CaptureSpec> {
        if let Some(pid) = source_id.strip_prefix("app:") {
            return pid.parse::<u32>().ok().filter(|p| *p > 0).map(CaptureSpec::App);
        }
        if source_id.is_empty() {
            None
        } else {
            Some(CaptureSpec::Device(source_id.to_string()))
        }
    }
}

/// Everything a capture thread needs. Captures always deliver interleaved stereo f32 at
/// the engine rate (48 kHz).
pub struct CaptureFeed {
    pub producer: rtrb::Producer<f32>,
    /// Called once when the source ends on its own (device unplugged, app exited...).
    pub on_end: Box<dyn FnOnce(String) + Send>,
    pub stop: Arc<AtomicBool>,
    pub alive: Arc<AtomicBool>,
}

/// Owns a running capture thread. Dropping it stops the thread.
pub struct CaptureHandle {
    pub stop: Arc<AtomicBool>,
    pub alive: Arc<AtomicBool>,
    pub thread: Option<JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A render stream, used only on the thread that opened it.
pub trait RenderStream {
    /// Device sample rate (streams are opened as stereo f32 at the engine rate when possible).
    fn rate(&self) -> f64;
    /// Block until the device wants more audio; returns the number of frames to write.
    fn wait_frames(&mut self, timeout_ms: u32) -> Result<usize, String>;
    /// Write interleaved stereo frames.
    fn write(&mut self, interleaved: &[f32]) -> Result<(), String>;
}

pub trait Backend: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    /// Per-thread setup (COM on Windows). Called at the start of every audio thread.
    fn thread_init(&self) {}
    fn list_devices(&self) -> Result<Vec<DeviceInfo>, String>;
    fn apps_supported(&self) -> bool;
    fn list_apps(&self, exclude_pids: &[u32]) -> Vec<AppInfo>;
    /// Start capturing. Returns once the stream is running (or failed to start).
    fn open_capture(&self, spec: &CaptureSpec, buffer_ms: u32, feed: CaptureFeed) -> Result<CaptureHandle, String>;
    fn open_render(&self, device_id: &str, buffer_ms: u32) -> Result<Box<dyn RenderStream>, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_source_ids() {
        assert_eq!(CaptureSpec::parse("app:1234"), Some(CaptureSpec::App(1234)));
        assert_eq!(CaptureSpec::parse("app:x"), None);
        assert_eq!(CaptureSpec::parse("app:0"), None);
        assert_eq!(CaptureSpec::parse(""), None);
        assert_eq!(CaptureSpec::parse("{0.0.1.00000000}.{abc}"), Some(CaptureSpec::Device("{0.0.1.00000000}.{abc}".into())));
    }
}
