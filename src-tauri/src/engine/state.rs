//! Engine parameters: the JSON the UI sends (`EngineState`) and the flat, linear form the
//! audio thread uses (`MixParams`).

use crate::dsp::{db_to_gain, MAX_BUS_DB, MAX_INPUT_DB, MIN_DB};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const BUS_COUNT: usize = 3;
pub const BUS_IDS: [&str; BUS_COUNT] = ["monitor", "monitor2", "output"];

pub fn bus_index(id: &str) -> Option<usize> {
    BUS_IDS.iter().position(|b| *b == id)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StripParams {
    pub source: Option<super::mixer::SourceKey>,
    /// Trim, linear.
    pub gain: f32,
    /// Enabled, not muted, and not silenced by someone else's solo.
    pub audible: bool,
    pub mono: bool,
    /// Send gains, linear (0 when the send is off or the bus is inactive).
    pub sends: [f32; BUS_COUNT],
}

#[derive(Clone, Debug, PartialEq)]
pub struct BusParams {
    /// Fader, linear (0 when muted or the bus has no device).
    pub volume: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MasterParams {
    pub eq_db: [f32; 3],
    pub drive_db: f32,
    pub soft_clip: bool,
    pub soft_clip_threshold_db: f32,
    pub limiter: bool,
    pub limiter_ceiling_db: f32,
}

impl Default for MasterParams {
    fn default() -> Self {
        Self { eq_db: [0.0; 3], drive_db: 0.0, soft_clip: true, soft_clip_threshold_db: -6.0, limiter: true, limiter_ceiling_db: -1.0 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MixParams {
    pub strips: Vec<StripParams>,
    pub buses: [BusParams; BUS_COUNT],
    pub master: MasterParams,
}

impl MixParams {
    pub fn silent(strips: usize) -> Self {
        Self {
            strips: vec![StripParams::default(); strips],
            buses: [BusParams { volume: 0.0 }, BusParams { volume: 0.0 }, BusParams { volume: 0.0 }],
            master: MasterParams::default(),
        }
    }
}

// ---------------------------------------------------------------- UI JSON

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SendState {
    pub on: bool,
    pub level_db: f32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StripState {
    /// Source id: a Windows capture endpoint id, or "app:<pid>". Empty = none.
    pub source: String,
    pub enabled: bool,
    pub gain_db: f32,
    pub mute: bool,
    pub solo: bool,
    pub force_mono: bool,
    pub sends: HashMap<String, SendState>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BusState {
    pub volume_db: f32,
    pub mute: bool,
    /// The bus has a connected device.
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EqState {
    pub low: f32,
    pub mid: f32,
    pub high: f32,
}

impl Default for EqState {
    fn default() -> Self {
        Self { low: 0.0, mid: 0.0, high: 0.0 }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ToggleDb {
    pub enabled: bool,
    #[serde(alias = "thresholdDb", alias = "ceilingDb")]
    pub db: f32,
}

impl Default for ToggleDb {
    fn default() -> Self {
        Self { enabled: true, db: -1.0 }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MasterState {
    pub eq: EqState,
    pub drive_db: f32,
    pub soft_clip: ToggleDb,
    pub limiter: ToggleDb,
}

impl Default for MasterState {
    fn default() -> Self {
        Self { eq: EqState::default(), drive_db: 0.0, soft_clip: ToggleDb { enabled: true, db: -6.0 }, limiter: ToggleDb { enabled: true, db: -1.0 } }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineState {
    pub strips: Vec<StripState>,
    pub buses: HashMap<String, BusState>,
    pub master: MasterState,
}

fn finite(v: f32, fallback: f32) -> f32 {
    if v.is_finite() { v } else { fallback }
}

impl EngineState {
    /// Convert to audio-thread parameters. `source_key` maps a source id to the key of an
    /// open source (None = not open yet: the strip stays silent).
    pub fn to_params(&self, strip_count: usize, source_key: impl Fn(&str) -> Option<super::mixer::SourceKey>) -> MixParams {
        let solo_active = self.strips.iter().any(|s| s.solo && s.enabled);
        let bus_active: Vec<bool> = BUS_IDS.iter().map(|id| self.buses.get(*id).map(|b| b.active).unwrap_or(false)).collect();
        let mut strips = vec![StripParams::default(); strip_count];
        for (i, s) in self.strips.iter().take(strip_count).enumerate() {
            let source = if s.source.is_empty() || !s.enabled { None } else { source_key(&s.source) };
            let audible = s.enabled && !s.mute && (!solo_active || s.solo);
            let mut sends = [0.0; BUS_COUNT];
            for (b, id) in BUS_IDS.iter().enumerate() {
                if let Some(send) = s.sends.get(*id) {
                    if send.on && bus_active[b] {
                        sends[b] = db_to_gain(finite(send.level_db, 0.0).clamp(MIN_DB, 0.0));
                    }
                }
            }
            strips[i] = StripParams {
                source,
                gain: db_to_gain(finite(s.gain_db, 0.0).clamp(MIN_DB, MAX_INPUT_DB)),
                audible,
                mono: s.force_mono,
                sends,
            };
        }
        let bus = |b: usize| {
            let st = self.buses.get(BUS_IDS[b]).cloned().unwrap_or_default();
            let volume = if !st.active || st.mute { 0.0 } else { db_to_gain(finite(st.volume_db, 0.0).clamp(MIN_DB, MAX_BUS_DB)) };
            BusParams { volume }
        };
        let m = &self.master;
        MixParams {
            strips,
            buses: [bus(0), bus(1), bus(2)],
            master: MasterParams {
                eq_db: [finite(m.eq.low, 0.0).clamp(-12.0, 12.0), finite(m.eq.mid, 0.0).clamp(-12.0, 12.0), finite(m.eq.high, 0.0).clamp(-12.0, 12.0)],
                drive_db: finite(m.drive_db, 0.0).clamp(0.0, 12.0),
                soft_clip: m.soft_clip.enabled,
                soft_clip_threshold_db: finite(m.soft_clip.db, -6.0).clamp(-18.0, -0.5),
                limiter: m.limiter.enabled,
                limiter_ceiling_db: finite(m.limiter.db, -1.0).clamp(-12.0, 0.0),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_json() -> EngineState {
        serde_json::from_value(serde_json::json!({
            "strips": [
                { "source": "mic", "enabled": true, "gainDb": 6, "mute": false, "solo": false, "forceMono": true,
                  "sends": { "monitor": { "on": true, "levelDb": 0 }, "monitor2": { "on": false, "levelDb": 0 }, "output": { "on": true, "levelDb": -6 } } },
                { "source": "app:42", "enabled": true, "gainDb": 30, "solo": true,
                  "sends": { "monitor": { "on": true, "levelDb": 0 } } },
                { "source": "", "enabled": true }
            ],
            "buses": { "monitor": { "volumeDb": 0, "active": true }, "monitor2": { "volumeDb": 0, "active": true }, "output": { "volumeDb": 3, "mute": true, "active": true } },
            "master": { "eq": { "low": 3, "mid": 0, "high": -2 }, "driveDb": 2, "softClip": { "enabled": false, "thresholdDb": -9 }, "limiter": { "enabled": true, "ceilingDb": -1 } }
        }))
        .unwrap()
    }

    #[test]
    fn converts_ui_state() {
        let s = state_json();
        let p = s.to_params(3, |id| match id { "mic" => Some(1), "app:42" => Some(2), _ => None });
        assert_eq!(p.strips[0].source, Some(1));
        assert!(!p.strips[0].audible, "silenced by the solo on strip 2");
        assert!(p.strips[0].mono);
        assert!(p.strips[1].audible);
        assert!((p.strips[1].gain - db_to_gain(24.0)).abs() < 1e-4, "trim clamped to +24 dB");
        assert_eq!(p.strips[0].sends[1], 0.0);
        assert!((p.strips[0].sends[2] - db_to_gain(-6.0)).abs() < 1e-6);
        assert_eq!(p.strips[2].source, None);
        assert_eq!(p.buses[2].volume, 0.0, "muted bus");
        assert_eq!(p.master.eq_db, [3.0, 0.0, -2.0]);
        assert!(!p.master.soft_clip);
        assert_eq!(p.master.soft_clip_threshold_db, -9.0);
        assert_eq!(p.master.limiter_ceiling_db, -1.0);
    }

    #[test]
    fn inactive_bus_gets_no_sends() {
        let mut s = state_json();
        s.buses.get_mut("monitor").unwrap().active = false;
        let p = s.to_params(3, |_| Some(1));
        assert_eq!(p.strips[1].sends[0], 0.0);
        assert_eq!(p.buses[0].volume, 0.0);
    }
}
