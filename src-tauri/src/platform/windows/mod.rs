//! WASAPI backend: shared-mode, event-driven capture and render (32-bit float, 48 kHz,
//! stereo, with Windows' own converter for devices that run at another rate or channel
//! count), plus per-app process loopback capture
//! (ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK).

pub mod apps;

use crate::engine::backend::{AppInfo, Backend, CaptureFeed, CaptureHandle, CaptureSpec, DeviceInfo, RenderStream};
use std::sync::atomic::Ordering;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};
use wasapi::{AudioCaptureClient, AudioClient, AudioRenderClient, DeviceEnumerator, Direction, Handle, SampleType, StreamMode, WasapiError, WaveFormat};

const RATE: usize = 48_000;
const AUDCLNT_E_DEVICE_INVALIDATED: u32 = 0x8889_0004;
const AUDCLNT_E_SERVICE_NOT_RUNNING: u32 = 0x8889_0010;

fn engine_format() -> WaveFormat {
    WaveFormat::new(32, 32, SampleType::Float, RATE, 2, None)
}

fn describe(e: &WasapiError) -> String {
    if let WasapiError::Windows(w) = e {
        let code = w.code().0 as u32;
        if code == AUDCLNT_E_DEVICE_INVALIDATED {
            return "device disconnected".into();
        }
        if code == AUDCLNT_E_SERVICE_NOT_RUNNING {
            return "Windows audio service stopped".into();
        }
        return format!("{} (0x{code:08X})", w.message());
    }
    e.to_string()
}

fn hns(ms: u32) -> i64 {
    ms as i64 * 10_000
}

pub struct WasapiBackend {
    apps_supported: bool,
}

impl WasapiBackend {
    pub fn new() -> Self {
        Self { apps_supported: apps::process_loopback_supported() }
    }
}

impl Default for WasapiBackend {
    fn default() -> Self {
        Self::new()
    }
}

fn list(direction: Direction, flow: &'static str) -> Result<Vec<DeviceInfo>, String> {
    let e = DeviceEnumerator::new().map_err(|e| describe(&e))?;
    let default_id = e.get_default_device(direction).and_then(|d| d.get_id()).unwrap_or_default();
    let col = e.get_device_collection(direction).map_err(|e| describe(&e))?;
    let count = col.get_nbr_devices().map_err(|e| describe(&e))?;
    let mut out = Vec::new();
    for i in 0..count {
        let Ok(dev) = col.get_device_at_index(i) else { continue };
        let Ok(id) = dev.get_id() else { continue };
        let name = dev.get_friendlyname().unwrap_or_else(|_| id.clone());
        let channels = dev.get_device_format().map(|f| f.get_nchannels()).unwrap_or(2);
        out.push(DeviceInfo { is_default: id == default_id, id, name, flow, channels });
    }
    Ok(out)
}

impl Backend for WasapiBackend {
    fn name(&self) -> &'static str {
        "wasapi"
    }

    fn thread_init(&self) {
        let _ = wasapi::initialize_mta();
        boost_thread_priority();
    }

    fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        // Device enumeration runs on Tauri's worker threads: make sure COM is up there.
        let _ = wasapi::initialize_mta();
        let mut all = list(Direction::Capture, "capture")?;
        all.extend(list(Direction::Render, "render")?);
        Ok(all)
    }

    fn apps_supported(&self) -> bool {
        self.apps_supported
    }

    fn list_apps(&self, exclude: &[u32]) -> Vec<AppInfo> {
        apps::list_windowed_apps(exclude)
    }

    fn open_capture(&self, spec: &CaptureSpec, buffer_ms: u32, feed: CaptureFeed) -> Result<CaptureHandle, String> {
        let stop = feed.stop.clone();
        let alive = feed.alive.clone();
        let (init_tx, init_rx) = channel::<Result<(), String>>();
        let spec = spec.clone();
        let thread = std::thread::Builder::new()
            .name("capture".into())
            .spawn(move || capture_thread(spec, buffer_ms, feed, init_tx))
            .map_err(|e| e.to_string())?;
        match init_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => Ok(CaptureHandle { stop, alive, thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                Err("the capture did not start in time".into())
            }
        }
    }

    fn open_render(&self, device_id: &str, buffer_ms: u32) -> Result<Box<dyn RenderStream>, String> {
        let _ = wasapi::initialize_mta();
        let e = DeviceEnumerator::new().map_err(|e| describe(&e))?;
        let dev = e.get_device(device_id).map_err(|e| describe(&e))?;
        let mut client = dev.get_iaudioclient().map_err(|e| describe(&e))?;
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: hns(buffer_ms) };
        client.initialize_client(&engine_format(), Direction::Render, mode, None).map_err(|e| describe(&e))?;
        let event = client.set_get_eventhandle().map_err(|e| describe(&e))?;
        let render = client.get_audiorenderclient().map_err(|e| describe(&e))?;
        client.start_stream().map_err(|e| describe(&e))?;
        Ok(Box::new(WasapiRender { client, render, event, bytes: Vec::new(), timeouts: 0 }))
    }
}

struct WasapiRender {
    client: AudioClient,
    render: AudioRenderClient,
    event: Handle,
    bytes: Vec<u8>,
    timeouts: u32,
}

impl RenderStream for WasapiRender {
    fn rate(&self) -> f64 {
        RATE as f64
    }

    fn wait_frames(&mut self, timeout_ms: u32) -> Result<usize, String> {
        match self.event.wait_for_event(timeout_ms) {
            Ok(()) => self.timeouts = 0,
            Err(WasapiError::EventTimeout) => {
                self.timeouts += 1;
                if self.timeouts as u64 * timeout_ms as u64 > 3000 {
                    return Err("the output device stopped responding".into());
                }
            }
            Err(e) => return Err(describe(&e)),
        }
        let frames = self.client.get_available_space_in_frames().map_err(|e| describe(&e))?;
        Ok(frames as usize)
    }

    fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        self.bytes.clear();
        self.bytes.reserve(interleaved.len() * 4);
        for s in interleaved {
            self.bytes.extend_from_slice(&s.to_le_bytes());
        }
        self.render.write_to_device(&self.bytes, None).map_err(|e| describe(&e))
    }
}

impl Drop for WasapiRender {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
    }
}

fn open_capture_client(spec: &CaptureSpec, buffer_ms: u32) -> Result<(AudioClient, AudioCaptureClient, Handle), String> {
    let mut client = match spec {
        CaptureSpec::Device(id) => {
            let e = DeviceEnumerator::new().map_err(|e| describe(&e))?;
            let dev = e.get_device(id).map_err(|e| describe(&e))?;
            dev.get_iaudioclient().map_err(|e| describe(&e))?
        }
        CaptureSpec::App(pid) => AudioClient::new_application_loopback_client(*pid, true).map_err(|e| {
            format!("could not capture this app ({})", describe(&e))
        })?,
    };
    // Process loopback is a virtual device: it takes the format we ask for. Real devices
    // are converted to 48 kHz stereo float by Windows.
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: hns(buffer_ms.max(20)) };
    client.initialize_client(&engine_format(), Direction::Capture, mode, None).map_err(|e| describe(&e))?;
    let event = client.set_get_eventhandle().map_err(|e| describe(&e))?;
    let capture = client.get_audiocaptureclient().map_err(|e| describe(&e))?;
    client.start_stream().map_err(|e| describe(&e))?;
    Ok((client, capture, event))
}

/// Audio threads (mixer, outputs, captures) run at time-critical priority so UI or other
/// app work on the PC cannot starve them.
fn boost_thread_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

fn capture_thread(spec: CaptureSpec, buffer_ms: u32, feed: CaptureFeed, init: std::sync::mpsc::Sender<Result<(), String>>) {
    let _ = wasapi::initialize_mta();
    boost_thread_priority();
    let CaptureFeed { mut producer, on_end, stop, alive } = feed;
    let (client, capture, event) = match open_capture_client(&spec, buffer_ms) {
        Ok(c) => {
            let _ = init.send(Ok(()));
            c
        }
        Err(e) => {
            alive.store(false, Ordering::Release);
            let _ = init.send(Err(e));
            return;
        }
    };
    let process = match spec {
        CaptureSpec::App(pid) => apps::ProcessWatch::open(pid),
        _ => None,
    };
    let mut buf = vec![0u8; RATE * 8]; // 1 s of stereo float
    let mut last_check = Instant::now();
    let mut ended: Option<String> = None;
    while !stop.load(Ordering::Acquire) {
        match event.wait_for_event(100) {
            Ok(()) | Err(WasapiError::EventTimeout) => {}
            Err(e) => {
                ended = Some(describe(&e));
                break;
            }
        }
        // drain every packet that is ready
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(_)) => {}
                Err(e) => {
                    ended = Some(describe(&e));
                    break;
                }
            }
            match capture.read_from_device(&mut buf) {
                Ok((frames, _info)) => {
                    let samples = frames as usize * 2;
                    if samples == 0 {
                        break;
                    }
                    let room = producer.slots().min(samples);
                    for i in 0..room {
                        let b = &buf[i * 4..i * 4 + 4];
                        let _ = producer.push(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                    }
                }
                Err(e) => {
                    ended = Some(describe(&e));
                    break;
                }
            }
        }
        if ended.is_some() {
            break;
        }
        // Process loopback sends nothing while the app is quiet, so silence is not an end.
        // Only the process exiting is.
        if last_check.elapsed() >= Duration::from_millis(500) {
            last_check = Instant::now();
            if let Some(p) = &process {
                if p.has_exited() {
                    ended = Some("process exited".into());
                    break;
                }
            }
        }
    }
    let _ = client.stop_stream();
    alive.store(false, Ordering::Release);
    if let Some(reason) = ended {
        if !stop.load(Ordering::Acquire) {
            on_end(reason);
        }
    }
}
