//! Shared handles for global skill-evolution state (skills DB + settings).

use std::path::PathBuf;
use std::sync::Arc;

use piscis_kernel::headless::KernelState;
use piscis_kernel::store::settings::Settings;
use tauri::AppHandle;
use tokio::sync::Mutex;

use super::data_scope::{open_global_kernel_state, resolve_global_config_dir};

pub struct SkillEvolutionCtx {
    pub config_dir: PathBuf,
    pub db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    pub settings: Arc<Mutex<Settings>>,
}

impl SkillEvolutionCtx {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let config_dir = resolve_global_config_dir(app)?;
        let (db, settings): KernelState = open_global_kernel_state(app)?;
        Ok(Self {
            config_dir,
            db,
            settings,
        })
    }

    pub fn skills_root(&self) -> PathBuf {
        crate::skills::service::skills_root_from_config_dir(&self.config_dir)
    }
}
