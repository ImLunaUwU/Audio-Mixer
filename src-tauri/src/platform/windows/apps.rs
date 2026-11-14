//! Running applications for the input picker (processes with a visible top-level window,
//! like the Electron build's ProcessList.exe) and process helpers for DUMP.

use crate::engine::backend::AppInfo;
use std::collections::{BTreeMap, HashMap};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER};

/// Process loopback needs Windows 10 2004 (build 19041) or newer.
/// Uses RtlGetVersion, which reports the real version regardless of the app manifest
/// (GetVersionEx reports Windows 8 without a supportedOS entry, hiding app capture).
pub fn process_loopback_supported() -> bool {
    if !cfg!(target_arch = "x86_64") {
        return false;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    let mut info = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    let status = unsafe { RtlGetVersion(&mut info) };
    status != 0 || info.dwMajorVersion > 10 || (info.dwMajorVersion == 10 && info.dwBuildNumber >= 19041)
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<(u32, String)>);
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    if GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 0 && !title.trim().is_empty() {
        out.push((pid, title));
    }
    BOOL(1)
}

pub fn exe_name(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let res = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(h);
        res.ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit(['\\', '/']).next().map(|s| s.to_string())
    }
}

/// Every running process by lower-case exe name (Toolhelp snapshot, like tasklist).
pub fn processes_by_exe() -> HashMap<String, Vec<u32>> {
    let mut map: HashMap<String, Vec<u32>> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            if !name.is_empty() {
                map.entry(name).or_default().push(entry.th32ProcessID);
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    map
}

pub fn list_windowed_apps(exclude: &[u32]) -> Vec<AppInfo> {
    let mut windows: Vec<(u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut _ as isize));
    }
    let mut by_pid: BTreeMap<u32, AppInfo> = BTreeMap::new();
    for (pid, title) in windows {
        if exclude.contains(&pid) || by_pid.contains_key(&pid) {
            continue;
        }
        let exe = exe_name(pid).unwrap_or_default();
        by_pid.insert(pid, AppInfo { pid, exe_name: exe, title });
    }
    let mut apps: Vec<AppInfo> = by_pid.into_values().collect();
    apps.sort_by_key(|a| (if a.exe_name.is_empty() { a.title.clone() } else { a.exe_name.clone() }).to_lowercase());
    apps
}

/// Watches a process for exit (capture ends with "process exited").
pub struct ProcessWatch(HANDLE);

unsafe impl Send for ProcessWatch {}

impl ProcessWatch {
    pub fn open(pid: u32) -> Option<Self> {
        unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok().map(ProcessWatch) }
    }

    pub fn has_exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }
}

impl Drop for ProcessWatch {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
