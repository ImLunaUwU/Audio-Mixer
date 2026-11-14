//! Settings files: atomic JSON writes, corrupt-file backups, and the one-time migration of
//! the Electron build's settings (config.json, deviceStates.json, dumpRouting.json).

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Read JSON. A file that exists but cannot be parsed is kept as `<name>.corrupt-<time>` so
/// settings are never silently lost.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            log::error!("could not parse {}: {e}", path.display());
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let backup = path.with_file_name(format!("{}.corrupt-{stamp}", path.file_name().and_then(|n| n.to_str()).unwrap_or("settings")));
            let _ = std::fs::copy(path, backup);
            None
        }
    }
}

/// Write to a temp file then rename, so a crash never leaves half a file.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub const MIGRATED_FILES: [&str; 4] = ["config.json", "deviceStates.json", "dumpRouting.json", "appRouting.json"];

/// Where the Electron build kept its settings: Electron's userData is %APPDATA%\<productName>
/// ("Audio Mixer"); older or renamed builds used the package or executable name.
pub fn electron_data_dirs(appdata: &Path) -> Vec<PathBuf> {
    ["Audio Mixer", "AudioMixer", "audio-mixer"].iter().map(|n| appdata.join(n)).collect()
}

/// Copy the Electron build's settings into `data_dir` once (only when this build has no
/// config.json yet). Returns the directory migrated from.
pub fn migrate_from_electron(data_dir: &Path, candidates: &[PathBuf]) -> Option<PathBuf> {
    if data_dir.join("config.json").exists() {
        return None;
    }
    let source = candidates.iter().find(|d| d.join("config.json").is_file() && d.as_path() != data_dir)?;
    std::fs::create_dir_all(data_dir).ok()?;
    for name in MIGRATED_FILES {
        let from = source.join(name);
        if from.is_file() {
            if let Err(e) = std::fs::copy(&from, data_dir.join(name)) {
                log::error!("settings migration: could not copy {}: {e}", from.display());
            }
        }
    }
    let note = serde_json::json!({ "migratedFrom": source.to_string_lossy(), "files": MIGRATED_FILES });
    let _ = write_json_atomic(&data_dir.join("migrated.json"), &note);
    log::info!("migrated settings from {}", source.display());
    Some(source.clone())
}

/// config.json + deviceStates.json, owned by the backend. The UI normalises the content
/// (same schema and migrations as the Electron build); the backend only keeps the window
/// geometry and reads a few app-level flags.
pub struct Store {
    pub dir: PathBuf,
    config: Mutex<Value>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let config = read_json::<Value>(&dir.join("config.json")).filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
        Self { dir, config: Mutex::new(config) }
    }

    pub fn config(&self) -> Value {
        self.config.lock().unwrap().clone()
    }

    pub fn bool_flag(&self, key: &str, default: bool) -> bool {
        self.config.lock().unwrap().get(key).and_then(Value::as_bool).unwrap_or(default)
    }

    pub fn latency_hint(&self) -> String {
        self.config.lock().unwrap().get("latencyHint").and_then(Value::as_str).unwrap_or("balanced").to_string()
    }

    pub fn window(&self) -> Option<Value> {
        self.config.lock().unwrap().get("window").cloned().filter(|w| w.is_object())
    }

    /// Save the UI's config, keeping the window geometry the backend owns.
    pub fn save_config(&self, mut next: Value) -> Result<(), String> {
        if !next.is_object() {
            return Err("config must be an object".into());
        }
        let mut cur = self.config.lock().unwrap();
        let window = cur.get("window").cloned().unwrap_or(Value::Null);
        next["window"] = window;
        *cur = next;
        write_json_atomic(&self.dir.join("config.json"), &*cur)
    }

    pub fn save_window(&self, window: Value) {
        let mut cur = self.config.lock().unwrap();
        cur["window"] = window;
        if let Err(e) = write_json_atomic(&self.dir.join("config.json"), &*cur) {
            log::error!("config write failed: {e}");
        }
    }

    pub fn device_states(&self) -> Value {
        read_json::<Value>(&self.dir.join("deviceStates.json")).filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}))
    }

    pub fn save_device_states(&self, states: Value) -> Result<(), String> {
        if !states.is_object() {
            return Err("device states must be an object".into());
        }
        write_json_atomic(&self.dir.join("deviceStates.json"), &states)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("am-store-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn migrates_electron_settings_once() {
        let root = tmp();
        let appdata = root.join("Roaming");
        let old = appdata.join("Audio Mixer");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("config.json"), r#"{"version":4,"presets":[{"name":"Stream"}]}"#).unwrap();
        std::fs::write(old.join("deviceStates.json"), "{}").unwrap();
        std::fs::write(old.join("dumpRouting.json"), r#"{"version":1,"entries":{}}"#).unwrap();
        let new_dir = appdata.join("dev.imluna.audio-mixer");
        let from = migrate_from_electron(&new_dir, &electron_data_dirs(&appdata));
        assert_eq!(from.as_deref(), Some(old.as_path()));
        let store = Store::open(new_dir.clone());
        assert_eq!(store.config()["presets"][0]["name"], "Stream");
        assert!(new_dir.join("dumpRouting.json").exists(), "crash-safety journal carried over");
        // second start: nothing is copied again
        std::fs::write(old.join("config.json"), r#"{"version":4,"presets":[]}"#).unwrap();
        assert!(migrate_from_electron(&new_dir, &electron_data_dirs(&appdata)).is_none());
    }

    #[test]
    fn save_keeps_window_and_writes_atomically() {
        let dir = tmp();
        let store = Store::open(dir.clone());
        store.save_window(serde_json::json!({ "width": 1000, "height": 700 }));
        store.save_config(serde_json::json!({ "closeToTray": false, "window": null })).unwrap();
        let on_disk: Value = read_json(&dir.join("config.json")).unwrap();
        assert_eq!(on_disk["window"]["width"], 1000);
        assert!(!store.bool_flag("closeToTray", true));
        assert!(!dir.join("config.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_is_backed_up() {
        let dir = tmp();
        std::fs::write(dir.join("config.json"), "{not json").unwrap();
        let store = Store::open(dir.clone());
        assert!(store.config().as_object().unwrap().is_empty());
        let backups = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("corrupt")).count();
        assert_eq!(backups, 1);
    }
}
