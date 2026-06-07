//! Flash (small / fast) model selection for delegated sub-agents (Fish).
//!
//! AgentZ pins the kernel from git, so we cannot extend the kernel's
//! `LlmProviderConfig` with a `use_as_flash` flag (the kernel owns
//! `config.json` serialization and silently drops unknown fields). Instead the
//! selection lives in a small AgentZ-owned file `{config}/flash.json` holding
//! the chosen provider id. Lightweight sub-agents (`delegate`, `call_fish`)
//! resolve their model from this provider when set, otherwise they fall back to
//! the main provider.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::data_scope::resolve_global_config_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FlashConfig {
    /// Provider id (from `settings.llm_providers`) to use as the flash model.
    #[serde(default)]
    pub provider_id: Option<String>,
}

fn flash_path(config_dir: &Path) -> PathBuf {
    config_dir.join("flash.json")
}

/// Read the configured flash provider id, if any (trimmed, non-empty).
pub fn load_flash_provider_id(config_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(flash_path(config_dir)).ok()?;
    let cfg: FlashConfig = serde_json::from_str(&text).ok()?;
    cfg.provider_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Get the current flash provider id (or `None` when unset).
#[tauri::command]
pub async fn flash_get(app: AppHandle) -> Result<Option<String>, String> {
    let dir = resolve_global_config_dir(&app)?;
    Ok(load_flash_provider_id(&dir))
}

/// Set (or clear, with `None`) the flash provider id.
#[tauri::command]
pub async fn flash_set(app: AppHandle, provider_id: Option<String>) -> Result<(), String> {
    let dir = resolve_global_config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = FlashConfig {
        provider_id: provider_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(flash_path(&dir), text).map_err(|e| e.to_string())?;
    Ok(())
}
