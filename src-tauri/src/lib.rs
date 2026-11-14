//! Luna's Audio Mixer, Tauri 2 shell: window, tray, settings, commands, and the glue between
//! the web UI and the Rust audio engine.

pub mod dsp;
pub mod dump;
pub mod engine;
pub mod platform;
pub mod store;

use dump::{DumpRequest, DumpRouter};
use engine::backend::{AppInfo, Backend, DeviceInfo};
use engine::state::EngineState;
use engine::{Engine, EventSink, OutputErrors};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::Store;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const REROUTE_SETTLE_MS: u64 = 400;
const DUMP_RETRY_S: u64 = 15;
const RESTORE_IF_UNSYNCED_S: u64 = 20;

pub struct AppState {
    store: Store,
    backend: Arc<dyn Backend>,
    engine: Mutex<Option<Engine>>,
    dump: Mutex<DumpRouter>,
    routing_synced: AtomicBool,
    quitting: AtomicBool,
    window_rev: AtomicU64,
    migrated_from: Option<String>,
}

type St<'a> = tauri::State<'a, Arc<AppState>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

fn with_engine<T>(state: &AppState, f: impl FnOnce(&mut Engine) -> T) -> Result<T, String> {
    let mut guard = state.engine.lock().map_err(|_| "engine lock poisoned".to_string())?;
    let engine = guard.as_mut().ok_or_else(|| "audio engine is not running".to_string())?;
    Ok(f(engine))
}

// ---------------------------------------------------------------- settings + app

#[tauri::command]
fn config_load(state: St) -> Value {
    state.store.config()
}

#[tauri::command]
fn config_save(state: St, config: Value) -> Result<(), String> {
    state.store.save_config(config)
}

#[tauri::command]
fn device_states_load(state: St) -> Value {
    state.store.device_states()
}

#[tauri::command]
fn device_states_save(state: St, states: Value) -> Result<(), String> {
    state.store.save_device_states(states)
}

#[tauri::command]
fn app_info(app: AppHandle, state: St) -> Value {
    json!({
        "version": app.package_info().version.to_string(),
        "isDev": cfg!(debug_assertions),
        "platform": std::env::consts::OS,
        "backend": state.backend.name(),
        "migratedFrom": state.migrated_from,
    })
}

#[tauri::command]
fn get_start_on_boot(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_start_on_boot(app: AppHandle, enabled: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let _ = if enabled { al.enable() } else { al.disable() };
    al.is_enabled().unwrap_or(false)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("only GitHub links can be opened".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- devices + apps

#[tauri::command]
async fn audio_list_devices(state: St<'_>) -> Result<Vec<DeviceInfo>, String> {
    let backend = state.backend.clone();
    blocking(move || backend.list_devices()).await?
}

#[tauri::command]
fn apps_supported(state: St) -> bool {
    state.backend.apps_supported()
}

#[tauri::command]
async fn apps_list(state: St<'_>) -> Result<Vec<AppInfo>, String> {
    let backend = state.backend.clone();
    blocking(move || backend.list_apps(&[std::process::id()])).await
}

// ---------------------------------------------------------------- engine

#[tauri::command]
fn engine_update(state: St, engine_state: EngineState) -> Result<(), String> {
    with_engine(&state, |e| e.update(engine_state))
}

#[tauri::command]
async fn engine_set_outputs(state: St<'_>, devices: HashMap<String, String>) -> Result<OutputErrors, String> {
    let st = state.inner().clone();
    blocking(move || with_engine(&st, |e| e.set_outputs(&devices))).await?
}

#[tauri::command]
async fn engine_open_source(state: St<'_>, source_id: String) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || with_engine(&st, |e| e.open_source(&source_id))).await???;
    Ok(())
}

#[tauri::command]
async fn engine_release_source(state: St<'_>, source_id: String) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || with_engine(&st, |e| e.release_source(&source_id))).await?
}

#[tauri::command]
async fn engine_release_all_except(state: St<'_>, keep: Vec<String>) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || with_engine(&st, |e| e.release_all_except(&keep))).await?
}

#[tauri::command]
fn engine_is_live(state: St, source_id: String) -> bool {
    with_engine(&state, |e| e.is_live(&source_id)).unwrap_or(false)
}

/// "Latency / Stability" changed: reconfigure buffers and reopen the output streams.
#[tauri::command]
async fn engine_set_latency(state: St<'_>, hint: String) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || with_engine(&st, |e| e.set_latency(&hint))).await?
}

#[tauri::command]
fn engine_set_meters(state: St, enabled: bool) {
    let _ = with_engine(&state, |e| e.set_meters_enabled(enabled));
}

// ---------------------------------------------------------------- DUMP

#[tauri::command]
fn dump_supported(state: St) -> bool {
    state.dump.lock().map(|d| d.is_supported()).unwrap_or(false)
}

#[tauri::command]
async fn dump_list_devices(state: St<'_>) -> Result<Vec<dump::RenderDevice>, String> {
    let st = state.inner().clone();
    blocking(move || st.dump.lock().map_err(|e| e.to_string())?.list_devices()).await?
}

fn reinit_moved_captures(st: &Arc<AppState>, changed: &[dump::Changed]) {
    let pids: Vec<u32> = changed.iter().flat_map(|c| c.pids.iter().copied()).collect();
    if pids.is_empty() {
        return;
    }
    let st = st.clone();
    std::thread::spawn(move || {
        // the app tears down its stream and opens a new one on the other endpoint first
        std::thread::sleep(Duration::from_millis(REROUTE_SETTLE_MS));
        let _ = with_engine(&st, |e| {
            for pid in pids {
                e.restart_app_capture(pid);
            }
        });
    });
}

#[tauri::command]
async fn dump_sync(state: St<'_>, desired: DumpRequest) -> Result<dump::SyncResult, String> {
    let st = state.inner().clone();
    blocking(move || {
        st.routing_synced.store(true, Ordering::Release);
        let mut desired = desired;
        desired.items.truncate(16);
        let result = st.dump.lock().map_err(|e| e.to_string())?.sync(&desired);
        reinit_moved_captures(&st, &result.changed);
        Ok(result)
    })
    .await?
}

// ---------------------------------------------------------------- window + tray

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = with_engine(&app.state::<Arc<AppState>>(), |e| e.set_meters_enabled(true));
    }
}

fn remember_window(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let st = app.state::<Arc<AppState>>().inner().clone();
    let maximized = w.is_maximized().unwrap_or(false);
    if maximized || w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        if let Some(mut saved) = st.store.window() {
            saved["maximized"] = json!(maximized);
            st.store.save_window(saved);
        }
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    st.store.save_window(json!({ "x": pos.x.round(), "y": pos.y.round(), "width": size.width.round(), "height": size.height.round(), "maximized": false }));
}

/// Save the window geometry 400 ms after the last move/resize.
fn schedule_remember_window(app: &AppHandle) {
    let st = app.state::<Arc<AppState>>().inner().clone();
    let rev = st.window_rev.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        if st.window_rev.load(Ordering::Acquire) == rev {
            remember_window(&app);
        }
    });
}

fn bounds_visible(app: &AppHandle, x: f64, y: f64, w: f64, _h: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let s = m.scale_factor();
        let p = m.position().to_logical::<f64>(s);
        let z = m.size().to_logical::<f64>(s);
        x < p.x + z.width - 50.0 && x + w > p.x + 50.0 && y >= p.y - 10.0 && y < p.y + z.height - 50.0
    })
}

fn create_window(app: &AppHandle, start_hidden: bool) -> tauri::Result<WebviewWindow> {
    let st = app.state::<Arc<AppState>>().inner().clone();
    let version = app.package_info().version.to_string();
    let saved = st.store.window();
    let num = |k: &str| saved.as_ref().and_then(|s| s.get(k)).and_then(Value::as_f64);
    let width = num("width").unwrap_or(1180.0).clamp(760.0, 4000.0);
    let height = num("height").unwrap_or(820.0).clamp(560.0, 3000.0);
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(format!("Audio Mixer v{version}"))
        .inner_size(width, height)
        .min_inner_size(760.0, 560.0)
        .background_color(tauri::window::Color(0x0f, 0x11, 0x15, 0xff))
        .visible(false)
        .disable_drag_drop_handler();
    match (num("x"), num("y")) {
        (Some(x), Some(y)) if bounds_visible(app, x, y, width, height) => builder = builder.position(x, y),
        _ => builder = builder.center(),
    }
    let win = builder.build()?;
    if saved.as_ref().and_then(|s| s.get("maximized")).and_then(Value::as_bool).unwrap_or(false) {
        let _ = win.maximize();
    }
    if !start_hidden {
        let _ = win.show();
    } else {
        let _ = with_engine(&st, |e| e.set_meters_enabled(false));
    }
    let handle = app.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_remember_window(&handle),
        WindowEvent::CloseRequested { api, .. } => {
            remember_window(&handle);
            let st = handle.state::<Arc<AppState>>();
            if st.quitting.load(Ordering::Acquire) || !st.store.bool_flag("closeToTray", true) {
                st.quitting.store(true, Ordering::Release);
                handle.exit(0);
            } else {
                api.prevent_close();
                if let Some(w) = main_window(&handle) {
                    let _ = w.hide();
                }
                let _ = with_engine(&st, |e| e.set_meters_enabled(false));
            }
        }
        _ => {}
    });
    Ok(win)
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    let show = MenuItem::with_id(app, "show", "Show Audio Mixer", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute / Unmute All Outputs", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mute, &sep, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(format!("Audio Mixer v{version}"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "mute" => {
                let _ = app.emit("app-command", "toggleMuteAll");
            }
            "quit" => {
                app.state::<Arc<AppState>>().quitting.store(true, Ordering::Release);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- background work

fn spawn_device_watch(app: AppHandle, backend: Arc<dyn Backend>) {
    std::thread::Builder::new()
        .name("device-watch".into())
        .spawn(move || {
            backend.thread_init();
            let mut last: Option<Vec<(String, String)>> = None;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let Ok(list) = backend.list_devices() else { continue };
                let sig: Vec<(String, String)> = list.into_iter().map(|d| (d.id, d.name)).collect();
                if last.as_ref().is_some_and(|l| *l != sig) {
                    let _ = app.emit("devices-changed", ());
                }
                last = Some(sig);
            }
        })
        .ok();
}

fn spawn_dump_maintenance(st: Arc<AppState>) {
    std::thread::Builder::new()
        .name("dump-maintenance".into())
        .spawn(move || {
            let _ = std::panic::catch_unwind(|| ());
            let start = std::time::Instant::now();
            let mut restored_unsynced = false;
            loop {
                std::thread::sleep(Duration::from_secs(DUMP_RETRY_S.min(RESTORE_IF_UNSYNCED_S)));
                if st.quitting.load(Ordering::Acquire) {
                    return;
                }
                let synced = st.routing_synced.load(Ordering::Acquire);
                let Ok(mut router) = st.dump.lock() else { return };
                if !router.has_pending() {
                    continue;
                }
                let result = if !synced {
                    // Left over from a crash and the mixer UI never took over: put those apps back.
                    if restored_unsynced && start.elapsed() < Duration::from_secs(RESTORE_IF_UNSYNCED_S) {
                        continue;
                    }
                    restored_unsynced = true;
                    router.restore_all()
                } else {
                    // apply to processes that started since, restore apps that came back
                    let desired = router.last_desired();
                    router.sync(&desired)
                };
                drop(router);
                reinit_moved_captures(&st, &result.changed);
            }
        })
        .ok();
}

fn cleanup(st: &AppState) {
    st.quitting.store(true, Ordering::Release);
    if let Ok(mut guard) = st.engine.lock() {
        if let Some(mut e) = guard.take() {
            e.shutdown();
        }
    }
    if let Ok(mut router) = st.dump.lock() {
        router.restore_all();
    }
}

fn data_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("AUDIO_MIXER_DATA_DIR") {
        return dir.into();
    }
    app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("audio-mixer"))
}

pub fn run() {
    let _ = env_logger_init();
    let start_hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir = data_dir(&handle);
            let migrated_from = std::env::var_os("APPDATA").and_then(|appdata| {
                store::migrate_from_electron(&dir, &store::electron_data_dirs(std::path::Path::new(&appdata)))
            });
            let store = Store::open(dir.clone());
            let backend = platform::default_backend();
            let events: EventSink = {
                let h = handle.clone();
                Arc::new(move |name: &str, payload: Value| {
                    let _ = h.emit(name, payload);
                })
            };
            let engine = Engine::new(backend.clone(), events, &store.latency_hint());
            let router = DumpRouter::new(dump::default_os(), dir.join("dumpRouting.json"), &[dir.join("appRouting.json")]);
            let state = Arc::new(AppState {
                store,
                backend: backend.clone(),
                engine: Mutex::new(Some(engine)),
                dump: Mutex::new(router),
                routing_synced: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                window_rev: AtomicU64::new(0),
                migrated_from: migrated_from.map(|p| p.to_string_lossy().to_string()),
            });
            app.manage(state.clone());
            create_window(&handle, start_hidden)?;
            create_tray(&handle)?;
            spawn_device_watch(handle.clone(), backend);
            spawn_dump_maintenance(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_load,
            config_save,
            device_states_load,
            device_states_save,
            app_info,
            get_start_on_boot,
            set_start_on_boot,
            open_external,
            audio_list_devices,
            apps_supported,
            apps_list,
            engine_update,
            engine_set_outputs,
            engine_open_source,
            engine_release_source,
            engine_release_all_except,
            engine_is_live,
            engine_set_latency,
            engine_set_meters,
            dump_supported,
            dump_list_devices,
            dump_sync
        ])
        .build(tauri::generate_context!())
        .expect("error while building Audio Mixer")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } => {
                if let Some(st) = app.try_state::<Arc<AppState>>() {
                    st.quitting.store(true, Ordering::Release);
                }
            }
            RunEvent::Exit => {
                if let Some(st) = app.try_state::<Arc<AppState>>() {
                    cleanup(&st);
                }
            }
            _ => {}
        });
}

fn env_logger_init() -> Result<(), log::SetLoggerError> {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info))
}
