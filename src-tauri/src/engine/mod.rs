//! Engine control: owns the mix thread, the capture threads and the output threads, and
//! turns UI requests into messages for the audio thread.
//!
//! Clocking (same idea as the Electron build): the first active bus plays directly from the
//! mix thread, so that device's clock drives the whole mix (no extra buffer, no resampling).
//! Every other bus goes through a lock-free ring to its own output thread, whose adaptive
//! buffer absorbs the drift between the two device clocks. Every input (devices and apps) has
//! its own adaptive buffer too. With no output at all, a timer clock keeps meters running.

pub mod backend;
pub mod mixer;
pub mod state;
pub mod sync;

use crate::dsp::jitter::AdaptiveRing;
use crate::dsp::meter::LevelAccum;
use backend::{Backend, CaptureFeed, CaptureHandle, CaptureSpec, RenderStream};
use mixer::{MeterData, Mixer, SourceKey, SourceSlot, MAX_BLOCK};
use serde::Serialize;
use serde_json::{json, Value};
use state::{EngineState, MixParams, BUS_COUNT, BUS_IDS};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use sync::SourceKind;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const ENGINE_RATE: f64 = 48_000.0;
pub const STRIP_COUNT: usize = 3;
const FEED_CAPACITY: usize = 48_000 * 2; // 1 s of stereo

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// "Latency / Stability" profiles.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyProfile {
    /// App (process loopback) jitter buffer target / floor.
    pub target_ms: f64,
    pub min_target_ms: f64,
    /// Device input (mic, line) jitter buffer target / floor. Devices deliver on a steady
    /// clock, so they can run a smaller buffer than process loopback.
    pub device_target_ms: f64,
    pub device_min_ms: f64,
    /// Secondary output buffer target / floor.
    pub output_target_ms: f64,
    pub output_min_ms: f64,
    /// WASAPI buffer duration requested for every stream.
    pub device_buffer_ms: u32,
}

/// Saved hint values, lowest latency first ("ultra" was added in 2.0; unknown values fall
/// back to "balanced").
pub const LATENCY_HINTS: [&str; 4] = ["ultra", "interactive", "balanced", "playback"];

impl LatencyProfile {
    pub fn from_hint(hint: &str) -> Self {
        match hint {
            // ~20 ms apps, ~10 ms devices. Every buffer still grows on its own after a dropout.
            "ultra" => Self {
                target_ms: 20.0,
                min_target_ms: 15.0,
                device_target_ms: 10.0,
                device_min_ms: 10.0,
                output_target_ms: 15.0,
                output_min_ms: 10.0,
                device_buffer_ms: 10,
            },
            "interactive" => Self {
                target_ms: 40.0,
                min_target_ms: 25.0,
                device_target_ms: 40.0,
                device_min_ms: 25.0,
                output_target_ms: 25.0,
                output_min_ms: 15.0,
                device_buffer_ms: 10,
            },
            "playback" => Self {
                target_ms: 100.0,
                min_target_ms: 70.0,
                device_target_ms: 100.0,
                device_min_ms: 70.0,
                output_target_ms: 60.0,
                output_min_ms: 40.0,
                device_buffer_ms: 40,
            },
            _ => Self {
                target_ms: 60.0,
                min_target_ms: 40.0,
                device_target_ms: 60.0,
                device_min_ms: 40.0,
                output_target_ms: 40.0,
                output_min_ms: 25.0,
                device_buffer_ms: 20,
            },
        }
    }

    /// Jitter buffer (target, floor) for an input of this kind.
    pub fn input_target(&self, kind: SourceKind) -> (f64, f64) {
        match kind {
            SourceKind::App => (self.target_ms, self.min_target_ms),
            SourceKind::Device => (self.device_target_ms, self.device_min_ms),
        }
    }
}

enum MixMsg {
    Params(MixParams),
    AddSource(SourceSlot),
    ReplaceFeed { key: SourceKey, feed: rtrb::Consumer<f32>, reset: bool },
    RemoveSource(SourceKey),
    Latency(LatencyProfile),
    SetPrimary { target: Option<(usize, String)>, reply: Sender<Result<(), String>> },
    SetSecondary { bus: usize, feed: Option<rtrb::Producer<f32>> },
    Stop,
}

struct OpenSource {
    key: SourceKey,
    handle: CaptureHandle,
}

struct OutputThread {
    device_id: String,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for OutputThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Shared between the engine, the mix thread and the meter thread.
struct Shared {
    meters: Mutex<MeterData>,
    /// source key -> source id, for stats
    names: Mutex<HashMap<SourceKey, String>>,
    /// true while the primary output stream is open
    primary_ok: AtomicBool,
    meters_enabled: AtomicBool,
    /// Secondary outputs: device latency + output buffer target (ms), 0 = unknown.
    out_latency_ms: [AtomicU32; BUS_COUNT],
}

pub struct Engine {
    backend: Arc<dyn Backend>,
    events: EventSink,
    shared: Arc<Shared>,
    tx: Sender<MixMsg>,
    mix_thread: Option<JoinHandle<()>>,
    meter_thread: Option<JoinHandle<()>>,
    meter_stop: Arc<AtomicBool>,
    latency: LatencyProfile,
    state: EngineState,
    sources: HashMap<String, OpenSource>,
    next_key: SourceKey,
    primary: Option<(usize, String)>,
    secondaries: [Option<OutputThread>; BUS_COUNT],
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct OutputErrors {
    pub errors: HashMap<String, String>,
    pub primary: Option<String>,
}

impl Engine {
    pub fn new(backend: Arc<dyn Backend>, events: EventSink, latency_hint: &str) -> Self {
        let shared = Arc::new(Shared {
            meters: Mutex::new(MeterData { strips: vec![LevelAccum::default(); STRIP_COUNT], ..Default::default() }),
            names: Mutex::new(HashMap::new()),
            primary_ok: AtomicBool::new(false),
            meters_enabled: AtomicBool::new(true),
            out_latency_ms: Default::default(),
        });
        let latency = LatencyProfile::from_hint(latency_hint);
        let (tx, rx) = channel();
        let mix_thread = {
            let backend = backend.clone();
            let shared = shared.clone();
            let events = events.clone();
            std::thread::Builder::new()
                .name("mixer".into())
                .spawn(move || mix_thread(backend, rx, shared, events, latency))
                .expect("spawn mixer thread")
        };
        let meter_stop = Arc::new(AtomicBool::new(false));
        let meter_thread = {
            let shared = shared.clone();
            let events = events.clone();
            let stop = meter_stop.clone();
            std::thread::Builder::new()
                .name("meters".into())
                .spawn(move || meter_thread(shared, events, stop))
                .expect("spawn meter thread")
        };
        Self {
            backend,
            events,
            shared,
            tx,
            mix_thread: Some(mix_thread),
            meter_thread: Some(meter_thread),
            meter_stop,
            latency,
            state: EngineState::default(),
            sources: HashMap::new(),
            next_key: 1,
            primary: None,
            secondaries: Default::default(),
        }
    }

    pub fn backend(&self) -> &Arc<dyn Backend> {
        &self.backend
    }

    pub fn latency(&self) -> LatencyProfile {
        self.latency
    }

    /// Meters are only emitted while the window is visible.
    pub fn set_meters_enabled(&self, enabled: bool) {
        self.shared.meters_enabled.store(enabled, Ordering::Release);
    }

    pub fn set_latency(&mut self, hint: &str) {
        let next = LatencyProfile::from_hint(hint);
        if next == self.latency {
            return;
        }
        self.latency = next;
        let _ = self.tx.send(MixMsg::Latency(next));
        // reopen outputs with the new device buffer size
        let wanted: Vec<String> = (0..BUS_COUNT)
            .map(|b| {
                if self.primary.as_ref().map(|p| p.0) == Some(b) {
                    self.primary.as_ref().unwrap().1.clone()
                } else {
                    self.secondaries[b].as_ref().map(|s| s.device_id.clone()).unwrap_or_default()
                }
            })
            .collect();
        self.primary = None;
        let _ = self.send_primary(None);
        for b in 0..BUS_COUNT {
            let _ = self.set_secondary(b, None);
        }
        let map: HashMap<String, String> = BUS_IDS.iter().zip(wanted).map(|(k, v)| (k.to_string(), v)).collect();
        let _ = self.set_outputs(&map);
    }

    fn push_params(&self) {
        let params = self.state.to_params(STRIP_COUNT, |id| self.sources.get(id).map(|s| s.key));
        let _ = self.tx.send(MixMsg::Params(params));
    }

    pub fn update(&mut self, state: EngineState) {
        self.state = state;
        self.push_params();
    }

    // ------------------------------------------------------------ sources

    pub fn is_live(&self, source_id: &str) -> bool {
        self.sources.get(source_id).map(|s| s.handle.is_alive()).unwrap_or(false)
    }

    fn start_capture(&self, source_id: &str, spec: &CaptureSpec) -> Result<(CaptureHandle, rtrb::Consumer<f32>), String> {
        let (producer, consumer) = rtrb::RingBuffer::new(FEED_CAPACITY);
        let events = self.events.clone();
        let id = source_id.to_string();
        let feed = CaptureFeed {
            producer,
            on_end: Box::new(move |reason| events("source-ended", json!({ "sourceId": id, "reason": reason }))),
            stop: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(true)),
        };
        let handle = self.backend.open_capture(spec, self.latency.device_buffer_ms, feed)?;
        Ok((handle, consumer))
    }

    /// Open (or keep) the capture for a source id.
    pub fn open_source(&mut self, source_id: &str) -> Result<(), String> {
        if self.is_live(source_id) {
            return Ok(());
        }
        let spec = CaptureSpec::parse(source_id).ok_or_else(|| "Invalid source.".to_string())?;
        if let CaptureSpec::App(_) = spec {
            if !self.backend.apps_supported() {
                return Err("Per-app audio capture requires Windows 10 (2004+) x64.".into());
            }
        }
        let (handle, consumer) = self.start_capture(source_id, &spec)?;
        if let Some(old) = self.sources.remove(source_id) {
            // dead capture: replace its feed, keep the key so strips stay bound
            let _ = self.tx.send(MixMsg::ReplaceFeed { key: old.key, feed: consumer, reset: true });
            self.sources.insert(source_id.to_string(), OpenSource { key: old.key, handle });
            drop(old.handle);
        } else {
            let key = self.next_key;
            self.next_key += 1;
            let kind = match spec {
                CaptureSpec::App(_) => SourceKind::App,
                CaptureSpec::Device(_) => SourceKind::Device,
            };
            let (target, floor) = self.latency.input_target(kind);
            let ring = AdaptiveRing::new(ENGINE_RATE, ENGINE_RATE, target, floor);
            let _ = self.tx.send(MixMsg::AddSource(SourceSlot::new(key, ring, Some(consumer)).with_kind(kind)));
            self.shared.names.lock().unwrap().insert(key, source_id.to_string());
            self.sources.insert(source_id.to_string(), OpenSource { key, handle });
        }
        self.push_params();
        Ok(())
    }

    pub fn release_source(&mut self, source_id: &str) {
        if let Some(src) = self.sources.remove(source_id) {
            let _ = self.tx.send(MixMsg::RemoveSource(src.key));
            self.shared.names.lock().unwrap().remove(&src.key);
            drop(src.handle);
            self.push_params();
        }
    }

    pub fn release_all_except(&mut self, keep: &[String]) {
        let ids: Vec<String> = self.sources.keys().filter(|id| !keep.contains(id)).cloned().collect();
        for id in ids {
            self.release_source(&id);
        }
    }

    pub fn open_source_ids(&self) -> Vec<String> {
        self.sources.keys().cloned().collect()
    }

    /// The app's Windows output moved (DUMP): re-initialise its process loopback capture and
    /// start the jitter buffer fresh, so the switch is one short gap instead of dropouts.
    pub fn restart_app_capture(&mut self, pid: u32) -> bool {
        let id = format!("app:{pid}");
        let Some(key) = self.sources.get(&id).map(|s| s.key) else { return false };
        match self.start_capture(&id, &CaptureSpec::App(pid)) {
            Ok((handle, consumer)) => {
                let _ = self.tx.send(MixMsg::ReplaceFeed { key, feed: consumer, reset: true });
                if let Some(old) = self.sources.insert(id.clone(), OpenSource { key, handle }) {
                    drop(old.handle);
                }
                (self.events)("app-rerouted", json!({ "pid": pid.to_string() }));
                true
            }
            Err(e) => {
                log::warn!("capture restart for {pid} failed: {e}");
                false
            }
        }
    }

    // ------------------------------------------------------------ outputs

    fn send_primary(&self, target: Option<(usize, String)>) -> Result<(), String> {
        let (reply, rx) = channel();
        self.tx.send(MixMsg::SetPrimary { target, reply }).map_err(|_| "audio engine stopped".to_string())?;
        rx.recv_timeout(Duration::from_secs(8)).map_err(|_| "the output device did not respond".to_string())?
    }

    fn set_secondary(&mut self, bus: usize, device: Option<&str>) -> Result<(), String> {
        let keep = match (&self.secondaries[bus], device) {
            (Some(t), Some(d)) => t.device_id == d && t.alive.load(Ordering::Acquire),
            (None, None) => true,
            _ => false,
        };
        if keep {
            return Ok(());
        }
        let _ = self.tx.send(MixMsg::SetSecondary { bus, feed: None });
        self.secondaries[bus] = None;
        let Some(device) = device else { return Ok(()) };
        let (producer, consumer) = rtrb::RingBuffer::new(FEED_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let (init_tx, init_rx) = channel();
        let thread = {
            let backend = self.backend.clone();
            let device = device.to_string();
            let stop = stop.clone();
            let alive = alive.clone();
            let events = self.events.clone();
            let latency = self.latency;
            let shared = self.shared.clone();
            std::thread::Builder::new()
                .name(format!("output-{}", BUS_IDS[bus]))
                .spawn(move || output_thread(backend, device, bus, consumer, latency, stop, alive, init_tx, events, shared))
                .map_err(|e| e.to_string())?
        };
        let result = init_rx.recv_timeout(Duration::from_secs(8)).unwrap_or_else(|_| Err("the output device did not respond".into()));
        let out = OutputThread { device_id: device.to_string(), stop, alive, thread: Some(thread) };
        match result {
            Ok(()) => {
                let _ = self.tx.send(MixMsg::SetSecondary { bus, feed: Some(producer) });
                self.secondaries[bus] = Some(out);
                Ok(())
            }
            Err(e) => {
                drop(out);
                Err(e)
            }
        }
    }

    /// `devices`: bus id -> render endpoint id ("" = off). Returns per-bus errors.
    pub fn set_outputs(&mut self, devices: &HashMap<String, String>) -> OutputErrors {
        let mut result = OutputErrors::default();
        let wanted: Vec<Option<String>> = BUS_IDS
            .iter()
            .map(|id| devices.get(*id).filter(|d| !d.is_empty()).cloned())
            .collect();
        let primary_bus = wanted.iter().position(|d| d.is_some());
        let target = primary_bus.map(|b| (b, wanted[b].clone().unwrap()));
        let primary_alive = self.shared.primary_ok.load(Ordering::Acquire);
        if target != self.primary || (target.is_some() && !primary_alive) {
            // a bus that was secondary may become primary: stop its output thread first
            if let Some((b, _)) = &target {
                self.set_secondary(*b, None).ok();
            }
            match self.send_primary(target.clone()) {
                Ok(()) => self.primary = target.clone(),
                Err(e) => {
                    self.primary = None;
                    if let Some((b, _)) = &target {
                        result.errors.insert(BUS_IDS[*b].to_string(), e);
                    }
                }
            }
        }
        result.primary = self.primary.as_ref().map(|(b, _)| BUS_IDS[*b].to_string());
        for b in 0..BUS_COUNT {
            if Some(b) == primary_bus {
                continue;
            }
            if let Err(e) = self.set_secondary(b, wanted[b].as_deref()) {
                result.errors.insert(BUS_IDS[b].to_string(), e);
            }
        }
        result
    }

    pub fn shutdown(&mut self) {
        self.sources.clear();
        for b in 0..BUS_COUNT {
            self.secondaries[b] = None;
        }
        let _ = self.tx.send(MixMsg::Stop);
        if let Some(t) = self.mix_thread.take() {
            let _ = t.join();
        }
        self.meter_stop.store(true, Ordering::Release);
        if let Some(t) = self.meter_thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------- threads

fn mix_thread(backend: Arc<dyn Backend>, rx: Receiver<MixMsg>, shared: Arc<Shared>, events: EventSink, latency: LatencyProfile) {
    backend.thread_init();
    let mut latency = latency;
    let mut mixer = Mixer::new(ENGINE_RATE as f32, STRIP_COUNT);
    let mut primary: Option<(usize, String, Box<dyn RenderStream>)> = None;
    let mut secondaries: [Option<rtrb::Producer<f32>>; BUS_COUNT] = Default::default();
    let mut scratch = vec![0f32; MAX_BLOCK * 2];
    let mut clock_start = Instant::now();
    let mut clock_frames: u64 = 0;

    loop {
        // control messages
        loop {
            let msg = match rx.try_recv() {
                Ok(m) => m,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
            };
            match msg {
                MixMsg::Params(p) => mixer.set_params(p),
                MixMsg::AddSource(slot) => mixer.add_source(slot),
                MixMsg::ReplaceFeed { key, feed, reset } => {
                    if let Some(src) = mixer.source_mut(key) {
                        src.feed = Some(feed);
                        if reset {
                            src.ring.reset();
                        }
                    }
                }
                MixMsg::RemoveSource(key) => mixer.remove_source(key),
                MixMsg::Latency(l) => {
                    latency = l;
                    for src in mixer.sources.iter_mut() {
                        let (target, floor) = l.input_target(src.kind);
                        src.ring.configure(target, floor);
                    }
                }
                MixMsg::SetPrimary { target, reply } => {
                    primary = None;
                    shared.primary_ok.store(false, Ordering::Release);
                    let res = match target {
                        None => Ok(()),
                        Some((bus, id)) => match backend.open_render(&id, latency.device_buffer_ms) {
                            Ok(stream) => {
                                primary = Some((bus, id, stream));
                                shared.primary_ok.store(true, Ordering::Release);
                                Ok(())
                            }
                            Err(e) => Err(e),
                        },
                    };
                    clock_start = Instant::now();
                    clock_frames = 0;
                    let _ = reply.send(res);
                }
                MixMsg::SetSecondary { bus, feed } => secondaries[bus] = feed,
                MixMsg::Stop => return,
            }
        }

        // output latency per bus, for the karaoke sync on MIX
        let mut out_ms: [Option<f64>; BUS_COUNT] = [None; BUS_COUNT];
        for (b, slot) in out_ms.iter_mut().enumerate() {
            if let Some((pb, _, stream)) = primary.as_ref() {
                if *pb == b {
                    *slot = Some(stream.latency_ms().unwrap_or(latency.device_buffer_ms as f64));
                    continue;
                }
            }
            if secondaries[b].is_some() {
                let ms = shared.out_latency_ms[b].load(Ordering::Relaxed);
                *slot = Some(if ms > 0 { ms as f64 } else { latency.device_buffer_ms as f64 + latency.output_target_ms });
            }
        }
        mixer.set_bus_latency(out_ms);

        // how many frames to mix now
        let frames = match primary.as_mut() {
            Some((bus, id, stream)) => match stream.wait_frames(50) {
                Ok(n) => n,
                Err(e) => {
                    events("output-error", json!({ "bus": BUS_IDS[*bus], "deviceId": id, "message": e }));
                    primary = None;
                    shared.primary_ok.store(false, Ordering::Release);
                    clock_start = Instant::now();
                    clock_frames = 0;
                    0
                }
            },
            None => {
                std::thread::sleep(Duration::from_millis(5));
                let due = (clock_start.elapsed().as_secs_f64() * ENGINE_RATE) as u64;
                let n = due.saturating_sub(clock_frames).min(4096);
                clock_frames = due;
                n as usize
            }
        };

        let mut left = frames;
        while left > 0 {
            let n = left.min(MAX_BLOCK);
            mixer.process(n);
            if let Some((bus, _, stream)) = primary.as_mut() {
                mixer.bus_interleaved(*bus, n, &mut scratch);
                if let Err(e) = stream.write(&scratch[..n * 2]) {
                    log::warn!("primary output write failed: {e}");
                }
            }
            for (b, feed) in secondaries.iter_mut().enumerate() {
                if let Some(p) = feed.as_mut() {
                    mixer.bus_interleaved(b, n, &mut scratch);
                    let room = p.slots().min(n * 2);
                    let room = room - room % 2;
                    if room > 0 {
                        if let Ok(mut chunk) = p.write_chunk(room) {
                            let (a, b2) = chunk.as_mut_slices();
                            let split = a.len();
                            a.copy_from_slice(&scratch[..split]);
                            b2.copy_from_slice(&scratch[split..room]);
                            chunk.commit_all();
                        }
                    }
                }
            }
            left -= n;
        }
        if let Ok(mut m) = shared.meters.try_lock() {
            m.merge(&mut mixer.meters);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn output_thread(
    backend: Arc<dyn Backend>,
    device_id: String,
    bus: usize,
    mut feed: rtrb::Consumer<f32>,
    latency: LatencyProfile,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    init: Sender<Result<(), String>>,
    events: EventSink,
    shared: Arc<Shared>,
) {
    backend.thread_init();
    let mut stream = match backend.open_render(&device_id, latency.device_buffer_ms) {
        Ok(s) => {
            let _ = init.send(Ok(()));
            s
        }
        Err(e) => {
            alive.store(false, Ordering::Release);
            let _ = init.send(Err(e));
            return;
        }
    };
    let mut ring = AdaptiveRing::new(ENGINE_RATE, stream.rate(), latency.output_target_ms, latency.output_min_ms);
    let device_ms = stream.latency_ms().unwrap_or(latency.device_buffer_ms as f64);
    let mut l = vec![0f32; 8192];
    let mut r = vec![0f32; 8192];
    let mut out = vec![0f32; 16384];
    while !stop.load(Ordering::Acquire) {
        let n = match stream.wait_frames(50) {
            Ok(n) => n.min(8192),
            Err(e) => {
                events("output-error", json!({ "bus": BUS_IDS[bus], "deviceId": device_id, "message": e }));
                break;
            }
        };
        let available = feed.slots() - feed.slots() % 2;
        if available > 0 {
            if let Ok(chunk) = feed.read_chunk(available) {
                let (a, b) = chunk.as_slices();
                if a.len() % 2 == 0 {
                    ring.push_interleaved(a);
                    ring.push_interleaved(b);
                } else {
                    ring.push_interleaved(&a[..a.len() - 1]);
                    ring.push_interleaved(&[a[a.len() - 1], b[0]]);
                    ring.push_interleaved(&b[1..]);
                }
                chunk.commit_all();
            }
        }
        let total = device_ms + ring.target() as f64 / ENGINE_RATE * 1000.0;
        shared.out_latency_ms[bus].store(total.round().max(1.0) as u32, Ordering::Relaxed);
        if n == 0 {
            continue;
        }
        ring.pull(&mut l[..n], &mut r[..n]);
        for i in 0..n {
            out[2 * i] = l[i];
            out[2 * i + 1] = r[i];
        }
        if let Err(e) = stream.write(&out[..n * 2]) {
            log::warn!("output write failed: {e}");
        }
    }
    alive.store(false, Ordering::Release);
    shared.out_latency_ms[bus].store(0, Ordering::Relaxed);
}

fn db_json(v: f32) -> Value {
    if v.is_finite() { json!((v * 10.0).round() / 10.0) } else { json!(-200) }
}

fn meter_thread(shared: Arc<Shared>, events: EventSink, stop: Arc<AtomicBool>) {
    let mut snapshot = MeterData { strips: vec![LevelAccum::default(); STRIP_COUNT], ..Default::default() };
    let mut last_stats = Instant::now();
    while !stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(33));
        {
            let mut m = shared.meters.lock().unwrap();
            snapshot.merge(&mut m);
        }
        if shared.meters_enabled.load(Ordering::Acquire) {
            let strips: Vec<Value> = snapshot
                .strips
                .iter_mut()
                .map(|a| {
                    let (p, r) = a.take().levels_db();
                    json!([db_json(p), db_json(r)])
                })
                .collect();
            let mut buses = serde_json::Map::new();
            for b in 0..BUS_COUNT {
                let (p, r) = snapshot.buses[b].take().levels_db();
                let gr = std::mem::replace(&mut snapshot.bus_gr_db[b], 0.0);
                buses.insert(BUS_IDS[b].to_string(), json!([db_json(p), db_json(r), db_json(gr)]));
            }
            events("meters", json!({ "inputs": strips, "buses": buses }));
        } else {
            for a in snapshot.strips.iter_mut() {
                a.take();
            }
            for b in 0..BUS_COUNT {
                snapshot.buses[b].take();
                snapshot.bus_gr_db[b] = 0.0;
            }
        }
        if last_stats.elapsed() >= Duration::from_secs(1) {
            last_stats = Instant::now();
            let names = shared.names.lock().unwrap().clone();
            for (key, s) in snapshot.sources.iter() {
                if let Some(id) = names.get(key) {
                    events(
                        "source-stats",
                        json!({ "sourceId": id, "fillMs": s.fill_ms, "targetMs": s.target_ms, "underruns": s.underruns, "gaps": s.gaps, "rate": s.rate }),
                    );
                }
            }
            let sync: Vec<Value> = snapshot.sync_ms.iter().map(|v| json!(v.round())).collect();
            events("sync", json!({ "auto": snapshot.sync_auto, "mixDelayMs": sync }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::demo::DemoBackend;

    fn collecting_sink() -> (EventSink, Arc<Mutex<Vec<(String, Value)>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s = store.clone();
        (Arc::new(move |name: &str, v: Value| s.lock().unwrap().push((name.to_string(), v))), store)
    }

    #[test]
    fn ultra_low_preset() {
        let u = LatencyProfile::from_hint("ultra");
        assert_eq!(u.input_target(SourceKind::App), (20.0, 15.0));
        assert_eq!(u.input_target(SourceKind::Device), (10.0, 10.0));
        assert_eq!(u.device_buffer_ms, 10);
        // lowest of all presets, in every buffer
        for hint in ["interactive", "balanced", "playback"] {
            let p = LatencyProfile::from_hint(hint);
            assert!(u.target_ms < p.target_ms && u.device_target_ms < p.device_target_ms && u.output_target_ms < p.output_target_ms, "{hint}");
        }
        // older presets unchanged
        let i = LatencyProfile::from_hint("interactive");
        assert_eq!((i.target_ms, i.min_target_ms, i.output_target_ms, i.device_buffer_ms), (40.0, 25.0, 25.0, 10));
        assert_eq!(LatencyProfile::from_hint("nonsense"), LatencyProfile::from_hint("balanced"));
        assert!(LATENCY_HINTS.iter().all(|h| *h == "balanced" || LatencyProfile::from_hint(h) != LatencyProfile::from_hint("balanced")));
    }

    #[test]
    fn end_to_end_with_demo_backend() {
        let backend: Arc<dyn Backend> = Arc::new(DemoBackend::new());
        let (sink, events) = collecting_sink();
        let mut engine = Engine::new(backend.clone(), sink, "balanced");
        let devices = backend.list_devices().unwrap();
        let mic = devices.iter().find(|d| d.flow == "capture").unwrap().id.clone();
        let out = devices.iter().find(|d| d.flow == "render").unwrap().id.clone();
        let out2 = devices.iter().filter(|d| d.flow == "render").nth(1).unwrap().id.clone();
        engine.open_source(&mic).unwrap();
        assert!(engine.is_live(&mic));
        let state: EngineState = serde_json::from_value(json!({
            "strips": [{ "source": mic, "enabled": true, "gainDb": 0, "sends": { "monitor": { "on": true, "levelDb": 0 }, "output": { "on": true, "levelDb": 0 } } }, {}, {}],
            "buses": { "monitor": { "active": true }, "monitor2": { "active": false }, "output": { "active": true } },
            "master": {}
        }))
        .unwrap();
        engine.update(state);
        let map: HashMap<String, String> = [("monitor".into(), out.clone()), ("monitor2".into(), String::new()), ("output".into(), out2)].into();
        let res = engine.set_outputs(&map);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(res.primary.as_deref(), Some("monitor"));
        std::thread::sleep(Duration::from_millis(1500));
        let ev = events.lock().unwrap().clone();
        let meters: Vec<&Value> = ev.iter().filter(|(n, _)| n == "meters").map(|(_, v)| v).collect();
        assert!(meters.len() > 10, "meters emitted at ~30 Hz");
        let last = meters.last().unwrap();
        let input_peak = last["inputs"][0][0].as_f64().unwrap();
        assert!(input_peak > -30.0, "demo tone reaches the strip meter: {last}");
        let bus_peak = last["buses"]["output"][0].as_f64().unwrap();
        assert!(bus_peak > -30.0, "and the MIX bus: {last}");
        assert!(ev.iter().any(|(n, _)| n == "source-stats"));
        let sync = ev.iter().rev().find(|(n, _)| n == "sync").map(|(_, v)| v.clone()).expect("sync event");
        assert_eq!(sync["mixDelayMs"].as_array().unwrap().len(), STRIP_COUNT);
        assert_eq!(sync["auto"], false, "only a mic on MIX: nothing to align");
        engine.release_source(&mic);
        assert!(!engine.is_live(&mic));
        engine.shutdown();
    }
}
