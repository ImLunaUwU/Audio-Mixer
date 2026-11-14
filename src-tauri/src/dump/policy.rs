//! Per-app persisted default endpoint (IAudioPolicyConfigFactory), natively in Rust.
//!
//! Undocumented Windows API, the same one behind Windows Settings > App volume and device
//! preferences (and EarTrumpet): the activation factory of
//! "Windows.Media.Internal.AudioPolicyConfig". Both known IIDs share the vtable layout:
//! IInspectable (6 slots), 19 methods we do not use, then SetPersistedDefaultAudioEndpoint
//! (25) and GetPersistedDefaultAudioEndpoint (26).

use super::{to_full_id, to_short_id, RenderDevice, RouterOs};
use std::collections::HashMap;
use std::ffi::c_void;
use windows::core::{GUID, HRESULT, HSTRING};

// Windows 10 21H2+ / Windows 11.
const IID_FACTORY_21H2: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
// Windows 10 1803 to 21H1.
const IID_FACTORY_DOWNLEVEL: GUID = GUID::from_u128(0x2a59116d_6c4f_45e0_a74f_707e3fef9258);

const SLOT_SET: usize = 25;
const SLOT_GET: usize = 26;
const E_RENDER: i32 = 0;
const E_CONSOLE: i32 = 0;
const E_MULTIMEDIA: i32 = 1;

type SetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut c_void) -> HRESULT;
type GetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut *mut c_void) -> HRESULT;
type ReleaseFn = unsafe extern "system" fn(*mut c_void) -> u32;

windows_link::link!("api-ms-win-core-winrt-l1-1-0.dll" "system" fn RoGetActivationFactory(activatableclassid: *mut c_void, iid: *const GUID, factory: *mut *mut c_void) -> HRESULT);

struct Factory(*mut c_void);

impl Factory {
    fn get() -> Result<Factory, String> {
        let _ = wasapi::initialize_mta();
        let class = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
        let mut out: *mut c_void = std::ptr::null_mut();
        unsafe {
            let raw: *mut c_void = std::mem::transmute_copy(&class);
            let mut hr = RoGetActivationFactory(raw, &IID_FACTORY_21H2, &mut out);
            if hr.is_err() {
                hr = RoGetActivationFactory(raw, &IID_FACTORY_DOWNLEVEL, &mut out);
            }
            if hr.is_err() || out.is_null() {
                return Err(format!("AudioPolicyConfig activation failed (0x{:08X})", hr.0 as u32));
            }
        }
        Ok(Factory(out))
    }

    unsafe fn slot(&self, i: usize) -> usize {
        let vtbl = *(self.0 as *const *const usize);
        *vtbl.add(i)
    }
}

impl Drop for Factory {
    fn drop(&mut self) {
        unsafe {
            let release: ReleaseFn = std::mem::transmute(self.slot(2));
            release(self.0);
        }
    }
}

pub struct WindowsRouterOs;

impl RouterOs for WindowsRouterOs {
    fn supported(&self) -> bool {
        true
    }

    fn get(&self, pid: u32) -> Result<String, String> {
        let f = Factory::get()?;
        unsafe {
            let get: GetFn = std::mem::transmute(f.slot(SLOT_GET));
            let mut out: *mut c_void = std::ptr::null_mut();
            let hr = get(f.0, pid, E_RENDER, E_MULTIMEDIA, &mut out);
            if hr.is_err() {
                return Err(format!("GetPersistedDefaultAudioEndpoint failed (0x{:08X})", hr.0 as u32));
            }
            if out.is_null() {
                return Ok(String::new());
            }
            let value: HSTRING = std::mem::transmute(out);
            Ok(to_short_id(&value.to_string_lossy()))
        }
    }

    fn set(&self, target: &str, pids: &[u32]) -> Result<(), String> {
        let f = Factory::get()?;
        let value = if target.is_empty() { None } else { Some(HSTRING::from(to_full_id(target))) };
        let mut failures = 0;
        let mut last = HRESULT(0);
        unsafe {
            let set: SetFn = std::mem::transmute(f.slot(SLOT_SET));
            let raw: *mut c_void = match &value {
                Some(h) => std::mem::transmute_copy(h),
                None => std::ptr::null_mut(),
            };
            for &pid in pids {
                let a = set(f.0, pid, E_RENDER, E_CONSOLE, raw);
                let b = set(f.0, pid, E_RENDER, E_MULTIMEDIA, raw);
                if a.is_err() || b.is_err() {
                    failures += 1;
                    last = if a.is_err() { a } else { b };
                }
            }
        }
        if !pids.is_empty() && failures == pids.len() {
            return Err(format!("SetPersistedDefaultAudioEndpoint failed (0x{:08X})", last.0 as u32));
        }
        Ok(())
    }

    fn processes(&self) -> HashMap<String, Vec<u32>> {
        crate::platform::windows::apps::processes_by_exe()
    }

    fn list_devices(&self) -> Result<Vec<RenderDevice>, String> {
        let _ = wasapi::initialize_mta();
        use wasapi::{DeviceEnumerator, Direction, Role};
        let e = DeviceEnumerator::new().map_err(|e| e.to_string())?;
        let default_id = e.get_default_device_for_role(Direction::Render, Role::Multimedia).and_then(|d| d.get_id()).unwrap_or_default();
        let col = e.get_device_collection(Direction::Render).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..col.get_nbr_devices().map_err(|e| e.to_string())? {
            let Ok(dev) = col.get_device_at_index(i) else { continue };
            let Ok(id) = dev.get_id() else { continue };
            let name = dev.get_friendlyname().unwrap_or_else(|_| id.clone());
            out.push(RenderDevice { is_default: id == default_id, id, name });
        }
        Ok(out)
    }
}

