//! Platform backends.

pub mod demo;
#[cfg(windows)]
pub mod windows;

use crate::engine::backend::Backend;
use std::sync::Arc;

/// The backend for this build: WASAPI on Windows, the demo backend elsewhere (or on Windows
/// when AUDIO_MIXER_DEMO=1 is set, for UI testing without touching real devices).
pub fn default_backend() -> Arc<dyn Backend> {
    #[cfg(windows)]
    {
        if std::env::var("AUDIO_MIXER_DEMO").ok().as_deref() != Some("1") {
            return Arc::new(windows::WasapiBackend::new());
        }
    }
    Arc::new(demo::DemoBackend::new())
}
