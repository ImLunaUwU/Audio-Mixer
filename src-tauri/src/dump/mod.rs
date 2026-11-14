//! DUMP: send an application's own Windows output to a "dump device" the user picked in
//! Settings (a device nobody listens to), so it stops playing straight into the headphones
//! while app capture (which follows the process, not the device) keeps feeding the mixer.
//! The dump device is never chosen automatically.
//!
//! Routing uses the per-app persisted default endpoint API (IAudioPolicyConfigFactory, the
//! one behind Windows Settings > App volume and device preferences, as used by EarTrumpet).
//! Windows keeps that setting per app after we exit, so every change is written to a journal
//! (dumpRouting.json) first and undone on toggle off, on quit, at the next start, or as soon
//! as the app runs again.

#[cfg(windows)]
pub mod policy;

use crate::store::{read_json, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

const DEVICE_PREFIX: &str = r"\\?\SWD#MMDEVAPI#";
const RENDER_INTERFACE: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";

/// "{0.0.0.00000000}.{guid}" -> full device interface path
pub fn to_full_id(short: &str) -> String {
    format!("{DEVICE_PREFIX}{short}{RENDER_INTERFACE}")
}

/// full device interface path -> "{0.0.0.00000000}.{guid}"
pub fn to_short_id(full: &str) -> String {
    let mut id = full;
    if let Some(i) = id.find("MMDEVAPI#") {
        id = &id[i + 9..];
    }
    if let Some(i) = id.find("#{") {
        id = &id[..i];
    }
    id.to_string()
}

pub fn exe_key(name: &str) -> String {
    name.trim().to_lowercase()
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// OS side of DUMP (injectable for tests).
pub trait RouterOs: Send + Sync {
    fn supported(&self) -> bool;
    /// Persisted render endpoint (short id) for a process, "" = Windows default.
    fn get(&self, pid: u32) -> Result<String, String>;
    /// Persist `target` (short id; "" clears back to the Windows default) for every pid.
    fn set(&self, target: &str, pids: &[u32]) -> Result<(), String>;
    /// Running processes by lower-case exe name.
    fn processes(&self) -> HashMap<String, Vec<u32>>;
    fn list_devices(&self) -> Result<Vec<RenderDevice>, String>;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct JournalEntry {
    pub exe_name: String,
    pub previous: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct JournalFile {
    version: u32,
    entries: BTreeMap<String, JournalEntry>,
}

#[derive(Clone, Debug, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpItem {
    pub exe_name: String,
    pub pid: String,
}

#[derive(Clone, Debug, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpRequest {
    pub target_id: String,
    pub items: Vec<DumpItem>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DumpError {
    pub exe_name: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Changed {
    pub key: String,
    pub pids: Vec<u32>,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq, Eq)]
pub struct SyncResult {
    pub dumped: Vec<String>,
    pub errors: Vec<DumpError>,
    #[serde(skip)]
    pub changed: Vec<Changed>,
}

pub struct DumpRouter {
    os: Box<dyn RouterOs>,
    journal_path: PathBuf,
    journal: BTreeMap<String, JournalEntry>,
    applied: HashMap<String, HashSet<u32>>,
    last_desired: DumpRequest,
}

impl DumpRouter {
    /// `legacy`: older journals (early 2.0 "Hide from Windows" used appRouting.json). Their
    /// entries are merged in so apps rerouted by an older build still get put back.
    pub fn new(os: Box<dyn RouterOs>, journal_path: PathBuf, legacy: &[PathBuf]) -> Self {
        let mut router = Self { os, journal_path, journal: BTreeMap::new(), applied: HashMap::new(), last_desired: DumpRequest::default() };
        let path = router.journal_path.clone();
        router.load(&path);
        let mut migrated = false;
        for file in legacy {
            if *file != router.journal_path && file.exists() {
                router.load(file);
                migrated = true;
            }
        }
        if migrated {
            router.save();
            for file in legacy {
                if *file != router.journal_path {
                    if let Err(e) = std::fs::remove_file(file) {
                        log::warn!("could not remove old journal {}: {e}", file.display());
                    }
                }
            }
        }
        router
    }

    fn load(&mut self, file: &PathBuf) {
        let loaded: JournalFile = read_json(file).unwrap_or_default();
        for (key, entry) in loaded.entries {
            if key.is_empty() || self.journal.contains_key(&key) {
                continue;
            }
            let exe_name = if entry.exe_name.is_empty() { key.clone() } else { entry.exe_name };
            self.journal.insert(key, JournalEntry { exe_name, ..entry });
        }
    }

    fn save(&self) {
        let result = if self.journal.is_empty() {
            if self.journal_path.exists() { std::fs::remove_file(&self.journal_path).map_err(|e| e.to_string()) } else { Ok(()) }
        } else {
            write_json_atomic(&self.journal_path, &JournalFile { version: 1, entries: self.journal.clone() })
        };
        if let Err(e) = result {
            log::error!("dump journal write failed: {e}");
        }
    }

    pub fn is_supported(&self) -> bool {
        self.os.supported()
    }

    pub fn list_devices(&self) -> Result<Vec<RenderDevice>, String> {
        if !self.os.supported() {
            return Ok(Vec::new());
        }
        let mut seen = HashSet::new();
        Ok(self.os.list_devices()?.into_iter().filter(|d| !d.id.is_empty() && seen.insert(d.id.clone())).collect())
    }

    pub fn pending(&self) -> Vec<String> {
        self.journal.keys().cloned().collect()
    }

    pub fn has_pending(&self) -> bool {
        !self.journal.is_empty()
    }

    pub fn last_desired(&self) -> DumpRequest {
        self.last_desired.clone()
    }

    /// Make Windows routing match what the UI wants. `target_id` "" (no dump device set)
    /// means nothing is dumped and earlier changes are undone.
    pub fn sync(&mut self, desired: &DumpRequest) -> SyncResult {
        let target = desired.target_id.clone();
        let mut items: Vec<(String, DumpItem)> = Vec::new();
        for item in &desired.items {
            let key = exe_key(&item.exe_name);
            if key.is_empty() || item.pid.is_empty() || !item.pid.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if items.iter().any(|(k, _)| *k == key) {
                continue;
            }
            items.push((key, item.clone()));
        }
        self.last_desired = DumpRequest { target_id: target.clone(), items: items.iter().map(|(_, i)| i.clone()).collect() };
        let mut result = SyncResult::default();
        if !self.os.supported() {
            if !items.is_empty() {
                result.errors.push(DumpError { exe_name: String::new(), message: "DUMP needs the Windows build of Audio Mixer.".into() });
            }
            return result;
        }
        let wanted: Vec<(String, DumpItem)> = if target.is_empty() { Vec::new() } else { items };
        if self.journal.is_empty() && wanted.is_empty() {
            return result;
        }
        let running = self.os.processes();

        // 1. undo routing that is no longer wanted (toggle off, input removed, source changed)
        let stale: Vec<String> = self.journal.keys().filter(|k| !wanted.iter().any(|(w, _)| w == *k)).cloned().collect();
        for key in stale {
            let pids = running.get(&key).cloned().unwrap_or_default();
            if pids.is_empty() {
                continue; // not running: restore when it comes back
            }
            let previous = self.journal[&key].previous.clone();
            match self.os.set(&previous, &pids) {
                Ok(()) => {
                    self.journal.remove(&key);
                    self.applied.remove(&key);
                    result.changed.push(Changed { key, pids });
                }
                Err(message) => result.errors.push(DumpError { exe_name: self.journal[&key].exe_name.clone(), message }),
            }
        }

        // 2. apply the target to every process of each wanted app
        for (key, item) in &wanted {
            let pid: u32 = item.pid.parse().unwrap_or(0);
            let pids = running.get(key).cloned().filter(|p| !p.is_empty()).unwrap_or_else(|| vec![pid]);
            if !self.journal.contains_key(key) {
                let previous = match self.os.get(pid) {
                    Ok(p) => p.trim().to_string(),
                    Err(e) => {
                        result.errors.push(DumpError { exe_name: item.exe_name.clone(), message: format!("could not read the current output ({e})") });
                        continue;
                    }
                };
                let previous = if previous == target { String::new() } else { previous };
                self.journal.insert(key.clone(), JournalEntry { exe_name: item.exe_name.clone(), previous, target: String::new() });
                self.save(); // journal first, so a crash right after still gets undone
            }
            let entry_target = self.journal[key].target.clone();
            let applied = self.applied.entry(key.clone()).or_default();
            let fresh: Vec<u32> = if entry_target != target { pids.clone() } else { pids.iter().copied().filter(|p| !applied.contains(p)).collect() };
            if !fresh.is_empty() {
                match self.os.set(&target, &fresh) {
                    Ok(()) => {
                        if entry_target != target {
                            applied.clear();
                        }
                        applied.extend(fresh.iter().copied());
                        self.journal.get_mut(key).unwrap().target = target.clone();
                        result.changed.push(Changed { key: key.clone(), pids: fresh });
                    }
                    Err(message) => {
                        if self.journal[key].target.is_empty() {
                            self.journal.remove(key);
                        }
                        result.errors.push(DumpError { exe_name: item.exe_name.clone(), message });
                        continue;
                    }
                }
            }
            result.dumped.push(key.clone());
        }
        self.save();
        result
    }

    pub fn restore_all(&mut self) -> SyncResult {
        self.sync(&DumpRequest::default())
    }
}

#[cfg(not(windows))]
pub struct UnsupportedOs;

#[cfg(not(windows))]
impl RouterOs for UnsupportedOs {
    fn supported(&self) -> bool {
        false
    }
    fn get(&self, _pid: u32) -> Result<String, String> {
        Err("unsupported".into())
    }
    fn set(&self, _t: &str, _p: &[u32]) -> Result<(), String> {
        Err("unsupported".into())
    }
    fn processes(&self) -> HashMap<String, Vec<u32>> {
        HashMap::new()
    }
    fn list_devices(&self) -> Result<Vec<RenderDevice>, String> {
        Ok(Vec::new())
    }
}

pub fn default_os() -> Box<dyn RouterOs> {
    #[cfg(windows)]
    {
        Box::new(policy::WindowsRouterOs)
    }
    #[cfg(not(windows))]
    {
        Box::new(UnsupportedOs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const TARGET: &str = "{0.0.0.00000000}.{SILENT}";
    const PREVIOUS: &str = "{0.0.0.00000000}.{SPEAKERS}";

    #[derive(Default)]
    struct FakeState {
        running: HashMap<String, Vec<u32>>,
        persisted: HashMap<u32, String>,
        calls: Vec<String>,
        fail_set: bool,
        supported: bool,
    }

    #[derive(Clone)]
    struct Fake(Arc<Mutex<FakeState>>);

    impl Fake {
        fn new() -> Self {
            let mut s = FakeState { supported: true, ..Default::default() };
            s.running.insert("spotify.exe".into(), vec![10, 11]);
            Fake(Arc::new(Mutex::new(s)))
        }
        fn persisted(&self, pid: u32) -> String {
            self.0.lock().unwrap().persisted.get(&pid).cloned().unwrap_or_default()
        }
        fn calls(&self) -> Vec<String> {
            self.0.lock().unwrap().calls.clone()
        }
    }

    impl RouterOs for Fake {
        fn supported(&self) -> bool {
            self.0.lock().unwrap().supported
        }
        fn get(&self, pid: u32) -> Result<String, String> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("get {pid}"));
            Ok(s.persisted.get(&pid).cloned().unwrap_or_default())
        }
        fn set(&self, target: &str, pids: &[u32]) -> Result<(), String> {
            let mut s = self.0.lock().unwrap();
            let shown = if target.is_empty() { "-" } else { target };
            s.calls.push(format!("set {shown} {}", pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ")));
            if s.fail_set {
                return Err("AudioPolicyConfig activation failed (0x80040154)".into());
            }
            for p in pids {
                s.persisted.insert(*p, target.to_string());
            }
            Ok(())
        }
        fn processes(&self) -> HashMap<String, Vec<u32>> {
            self.0.lock().unwrap().running.clone()
        }
        fn list_devices(&self) -> Result<Vec<RenderDevice>, String> {
            Ok(vec![
                RenderDevice { id: "{a}".into(), name: "Headphones".into(), is_default: true },
                RenderDevice { id: "{b}".into(), name: "CABLE Input".into(), is_default: false },
                RenderDevice { id: "{b}".into(), name: "dup".into(), is_default: false },
            ])
        }
    }

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("am-dump-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn req(target: &str, items: &[(&str, &str)]) -> DumpRequest {
        DumpRequest { target_id: target.into(), items: items.iter().map(|(e, p)| DumpItem { exe_name: e.to_string(), pid: p.to_string() }).collect() }
    }

    #[test]
    fn dumps_every_process_and_restores_previous_device() {
        let fake = Fake::new();
        fake.0.lock().unwrap().persisted.insert(10, PREVIOUS.into());
        let journal = tmp_dir().join("dumpRouting.json");
        let mut r = DumpRouter::new(Box::new(fake.clone()), journal.clone(), &[]);
        let res = r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        assert_eq!(res.dumped, vec!["spotify.exe"]);
        assert_eq!(res.changed, vec![Changed { key: "spotify.exe".into(), pids: vec![10, 11] }]);
        assert_eq!(fake.persisted(10), TARGET);
        assert_eq!(fake.persisted(11), TARGET);
        let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&journal).unwrap()).unwrap();
        assert_eq!(j["entries"]["spotify.exe"]["previous"], PREVIOUS);

        let before = fake.calls().len();
        let again = r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        assert_eq!(fake.calls().len(), before, "unchanged request touches nothing");
        assert!(again.changed.is_empty());
        assert_eq!(again.dumped, vec!["spotify.exe"]);

        r.sync(&req(TARGET, &[]));
        assert_eq!(fake.persisted(10), PREVIOUS);
        assert_eq!(fake.persisted(11), PREVIOUS);
        assert!(!journal.exists());
    }

    #[test]
    fn default_routing_is_restored_by_clearing() {
        let fake = Fake::new();
        let mut r = DumpRouter::new(Box::new(fake.clone()), tmp_dir().join("j.json"), &[]);
        r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        r.restore_all();
        assert!(fake.calls().contains(&"set - 10 11".to_string()));
        assert_eq!(fake.persisted(10), "");
    }

    #[test]
    fn new_processes_get_the_target_too() {
        let fake = Fake::new();
        let mut r = DumpRouter::new(Box::new(fake.clone()), tmp_dir().join("j.json"), &[]);
        r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        fake.0.lock().unwrap().running.insert("spotify.exe".into(), vec![10, 11, 12]);
        r.sync(&req(TARGET, &[("Spotify.exe", "12")]));
        assert_eq!(fake.calls().last().unwrap(), &format!("set {TARGET} 12"));
    }

    #[test]
    fn crash_journal_is_undone_when_the_app_runs() {
        let dir = tmp_dir();
        let journal = dir.join("dumpRouting.json");
        std::fs::write(&journal, format!(r#"{{"version":1,"entries":{{"spotify.exe":{{"exeName":"Spotify.exe","previous":"{PREVIOUS}","target":"{TARGET}"}}}}}}"#)).unwrap();
        let fake = Fake::new();
        fake.0.lock().unwrap().running.clear();
        let mut r = DumpRouter::new(Box::new(fake.clone()), journal.clone(), &[]);
        r.restore_all();
        assert_eq!(r.pending(), vec!["spotify.exe"], "kept until the app is running");
        fake.0.lock().unwrap().running.insert("spotify.exe".into(), vec![20]);
        r.restore_all();
        assert_eq!(fake.persisted(20), PREVIOUS);
        assert!(r.pending().is_empty());
        assert!(!journal.exists());
    }

    #[test]
    fn no_dump_device_means_nothing_is_dumped() {
        let fake = Fake::new();
        let mut r = DumpRouter::new(Box::new(fake.clone()), tmp_dir().join("j.json"), &[]);
        r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        let res = r.sync(&req("", &[("Spotify.exe", "10")]));
        assert!(res.dumped.is_empty());
        assert_eq!(fake.persisted(10), "");
    }

    #[test]
    fn failure_is_reported_and_leaves_no_journal_entry() {
        let fake = Fake::new();
        fake.0.lock().unwrap().fail_set = true;
        let mut r = DumpRouter::new(Box::new(fake), tmp_dir().join("j.json"), &[]);
        let res = r.sync(&req(TARGET, &[("Spotify.exe", "10")]));
        assert!(res.dumped.is_empty());
        assert!(res.errors[0].message.contains("0x80040154"));
        assert!(r.pending().is_empty());
    }

    #[test]
    fn unsupported_reports_an_error() {
        let fake = Fake::new();
        fake.0.lock().unwrap().supported = false;
        let mut r = DumpRouter::new(Box::new(fake), tmp_dir().join("j.json"), &[]);
        assert_eq!(r.sync(&req(TARGET, &[("Spotify.exe", "10")])).errors.len(), 1);
    }

    #[test]
    fn legacy_journal_is_migrated_and_restored() {
        let dir = tmp_dir();
        let legacy = dir.join("appRouting.json");
        let journal = dir.join("dumpRouting.json");
        std::fs::write(&legacy, r#"{"version":1,"entries":{"spotify.exe":{"exeName":"Spotify.exe","previous":"","target":"{0.0.0.00000000}.{LINE1}"}}}"#).unwrap();
        let fake = Fake::new();
        let mut r = DumpRouter::new(Box::new(fake.clone()), journal.clone(), &[legacy.clone()]);
        assert_eq!(r.pending(), vec!["spotify.exe"]);
        assert!(!legacy.exists());
        assert!(journal.exists());
        let res = r.restore_all();
        assert_eq!(res.changed, vec![Changed { key: "spotify.exe".into(), pids: vec![10, 11] }]);
        assert_eq!(fake.persisted(10), "");
        assert!(r.pending().is_empty());
    }

    #[test]
    fn endpoint_id_round_trip() {
        let short = "{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}";
        let full = to_full_id(short);
        assert_eq!(full, format!(r"\\?\SWD#MMDEVAPI#{short}#{{e6327cad-dcec-4949-ae8a-991e976a79d2}}"));
        assert_eq!(to_short_id(&full), short);
        assert_eq!(to_short_id(short), short);
    }

    #[test]
    fn device_list_drops_duplicate_ids() {
        let r = DumpRouter::new(Box::new(Fake::new()), tmp_dir().join("j.json"), &[]);
        let d = r.list_devices().unwrap();
        assert_eq!(d.len(), 2);
        assert!(d[0].is_default);
    }
}
