//! Project-local chat storage — sessions live in `{project}/.agentz/piscis.db`.
//! LLM settings (`config.json`) always load from the global config dir.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use piscis_kernel::headless::KernelState;
use piscis_kernel::store::db::Database;
use piscis_kernel::store::settings::Settings;

/// Project-local directory for AgentZ session data.
pub const PROJECT_DATA_DIR: &str = ".agentz";

/// Session source tag written into `piscis.db` (shared by IDE + Agent).
pub const SESSION_SOURCE: &str = "agentz";

/// Global directory holding `config.json`.
pub fn resolve_global_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("AGENTZ_CONFIG_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// `{project}/.agentz`
pub fn resolve_project_data_dir(project_dir: &str) -> Result<PathBuf, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return Err("project directory is empty".to_string());
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(format!("project directory not found: {trimmed}"));
    }
    Ok(root.join(PROJECT_DATA_DIR))
}

pub fn require_project_dir(project_dir: Option<&str>) -> Result<String, String> {
    let dir = project_dir
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| "project_dir is required".to_string())?;
    resolve_project_data_dir(dir)?;
    Ok(dir.to_string())
}

fn open_kernel_state_split(config_dir: &Path, db_dir: &Path) -> anyhow::Result<KernelState> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("failed to create config dir {}", config_dir.display()))?;
    std::fs::create_dir_all(db_dir)
        .with_context(|| format!("failed to create db dir {}", db_dir.display()))?;
    let db_path = db_dir.join("piscis.db");
    let db = Database::open(&db_path)
        .with_context(|| format!("failed to open DB at {}", db_path.display()))?;
    let config_path = config_dir.join("config.json");
    let settings = Settings::load(&config_path)
        .with_context(|| format!("failed to load {}", config_path.display()))?;
    Ok((Arc::new(Mutex::new(db)), Arc::new(Mutex::new(settings))))
}

/// Global LLM settings + project-local session database.
pub fn open_project_kernel_state(
    app: &AppHandle,
    project_dir: &str,
) -> Result<KernelState, String> {
    let config_dir = resolve_global_config_dir(app)?;
    let db_dir = resolve_project_data_dir(project_dir)?;
    open_kernel_state_split(&config_dir, &db_dir)
        .map_err(|e| format!("failed to initialise kernel state: {e}"))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectDirParam {
    pub project_dir: Option<String>,
}

impl ProjectDirParam {
    pub fn required(&self) -> Result<String, String> {
        require_project_dir(self.project_dir.as_deref())
    }
}
