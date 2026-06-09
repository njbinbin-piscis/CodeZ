//! Tauri commands for the User Tool plugin system (Phase 0).
//!
//! User tools live in `{config}/user-tools/<name>/` and are scanned at the
//! start of each agent turn (see `chat_turn.rs`) to be registered dynamically
//! in the tool registry. This module ports openpiscis' `user_tools.rs` to the
//! AgentZ host, whose settings live in a global `config.json` (loaded on demand)
//! rather than in shared `AppState`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tracing::info;

use piscis_kernel::store::settings::Settings;
use piscis_kernel::tools::user_tool::{ConfigFieldSchema, UserToolManifest};

use crate::commands::data_scope::resolve_global_config_dir;

// ─── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct UserToolInfo {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub runtime: String,
    pub entrypoint: String,
    pub input_schema: Value,
    pub config_schema: HashMap<String, ConfigFieldSchema>,
    pub has_config: bool,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// `{config}/user-tools` — mirrors the load path used in `chat_turn.rs`.
fn user_tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_global_config_dir(app)?.join("user-tools"))
}

/// Load the global `config.json` (so we can read/write `user_tool_configs`).
fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let config_path = resolve_global_config_dir(app)?.join("config.json");
    Settings::load(&config_path).map_err(|e| e.to_string())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Return the list of installed user tools, including their config schemas.
#[tauri::command]
pub async fn user_tools_list(app: AppHandle) -> Result<Vec<UserToolInfo>, String> {
    let tools_dir = user_tools_dir(&app)?;
    let tools = piscis_kernel::tools::user_tool::load_user_tools(&tools_dir);

    let settings = load_settings(&app)?;
    let result = tools
        .into_iter()
        .map(|t| {
            let has_config = settings.user_tool_configs.contains_key(&t.manifest.name);
            UserToolInfo {
                name: t.manifest.name.clone(),
                description: t.manifest.description.clone(),
                version: t.manifest.version.clone(),
                author: t.manifest.author.clone(),
                runtime: t.manifest.runtime.clone(),
                entrypoint: t.manifest.entrypoint.clone(),
                input_schema: t.manifest.input_schema.clone(),
                config_schema: t.manifest.config_schema.clone(),
                has_config,
            }
        })
        .collect();

    Ok(result)
}

/// Install a user tool from a URL (zip or raw manifest) or a local directory.
#[tauri::command]
pub async fn user_tools_install(app: AppHandle, source: String) -> Result<UserToolInfo, String> {
    let tools_dir = user_tools_dir(&app)?;
    tokio::fs::create_dir_all(&tools_dir)
        .await
        .map_err(|e| format!("Failed to create user-tools dir: {}", e))?;

    if source.starts_with("http://") || source.starts_with("https://") {
        // Block private/internal addresses (SSRF guard).
        let blocked = [
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "192.168.",
            "10.",
            "172.",
        ];
        for pat in &blocked {
            if source.contains(pat) {
                return Err(format!(
                    "Blocked URL: '{}' targets a private address",
                    source
                ));
            }
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;

        if source.ends_with(".zip") {
            let bytes = client
                .get(&source)
                .header("User-Agent", "AgentZ-Desktop/1.0")
                .send()
                .await
                .map_err(|e| format!("Download error: {}", e))?
                .bytes()
                .await
                .map_err(|e| format!("Read error: {}", e))?;

            let tools_dir_cloned = tools_dir.clone();
            let result =
                tokio::task::spawn_blocking(move || extract_zip(&bytes, &tools_dir_cloned))
                    .await
                    .map_err(|e| format!("Spawn error: {}", e))?
                    .map_err(|e| format!("Zip extraction failed: {}", e))?;

            return Ok(result);
        } else {
            let manifest_text = client
                .get(&source)
                .header("User-Agent", "AgentZ-Desktop/1.0")
                .send()
                .await
                .map_err(|e| format!("Download error: {}", e))?
                .text()
                .await
                .map_err(|e| format!("Read error: {}", e))?;

            let manifest: UserToolManifest = serde_json::from_str(&manifest_text)
                .map_err(|e| format!("Invalid manifest.json: {}", e))?;

            validate_manifest_name(&manifest.name)?;

            let safe_name = safe_tool_name(&manifest.name);
            let tool_dir = tools_dir.join(&safe_name);
            tokio::fs::create_dir_all(&tool_dir)
                .await
                .map_err(|e| format!("Failed to create tool dir: {}", e))?;

            tokio::fs::write(tool_dir.join("manifest.json"), &manifest_text)
                .await
                .map_err(|e| format!("Failed to write manifest: {}", e))?;

            info!("Installed user tool '{}' from manifest URL", manifest.name);

            return Ok(manifest_to_info(manifest, false));
        }
    }

    // Local path: must be an existing directory with manifest.json.
    let local_path = PathBuf::from(&source);
    if !local_path.is_dir() {
        return Err(format!("'{}' is not a directory", source));
    }

    let manifest = UserToolManifest::load(&local_path)
        .map_err(|e| format!("Failed to load manifest.json: {}", e))?;

    validate_manifest_name(&manifest.name)?;

    let safe_name = safe_tool_name(&manifest.name);
    let tool_dir = tools_dir.join(&safe_name);

    copy_dir_all(&local_path, &tool_dir)
        .map_err(|e| format!("Failed to copy tool files: {}", e))?;

    info!(
        "Installed user tool '{}' from local path: {}",
        manifest.name, source
    );

    Ok(manifest_to_info(manifest, false))
}

/// Remove an installed user tool directory and its persisted config.
#[tauri::command]
pub async fn user_tools_uninstall(app: AppHandle, tool_name: String) -> Result<(), String> {
    let tools_dir = user_tools_dir(&app)?;
    let safe_name = safe_tool_name(&tool_name);
    let tool_dir = tools_dir.join(&safe_name);

    if !tool_dir.exists() {
        return Err(format!("User tool '{}' not found", tool_name));
    }

    // Safety: ensure the resolved path is still inside user-tools/.
    let canonical = tool_dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical_base = tools_dir
        .canonicalize()
        .unwrap_or_else(|_| tools_dir.clone());
    if !canonical.starts_with(&canonical_base) {
        return Err("Path traversal attempt blocked".into());
    }

    tokio::fs::remove_dir_all(&tool_dir)
        .await
        .map_err(|e| format!("Failed to remove tool: {}", e))?;

    let mut settings = load_settings(&app)?;
    if settings.user_tool_configs.remove(&tool_name).is_some() {
        settings
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;
    }

    info!("Uninstalled user tool '{}'", tool_name);
    Ok(())
}

/// Persist tool configuration (credentials etc.) into Settings. Password fields
/// declared in the manifest's `config_schema` are encrypted by `Settings::save`.
#[tauri::command]
pub async fn user_tools_save_config(
    app: AppHandle,
    tool_name: String,
    config: HashMap<String, Value>,
) -> Result<(), String> {
    let tools_dir = user_tools_dir(&app)?;
    let safe_name = safe_tool_name(&tool_name);
    let tool_dir = tools_dir.join(&safe_name);

    // Validate the tool exists (config keys are accepted as-is; the Settings
    // encryption layer handles secret fields on save).
    UserToolManifest::load(&tool_dir)
        .map_err(|e| format!("Tool '{}' not found: {}", tool_name, e))?;

    let mut config_value = serde_json::Map::new();
    for (key, value) in config {
        config_value.insert(key, value);
    }

    let mut settings = load_settings(&app)?;
    settings
        .user_tool_configs
        .insert(tool_name.clone(), Value::Object(config_value));
    settings
        .save()
        .map_err(|e| format!("Failed to save config: {}", e))?;

    info!("Saved config for user tool '{}'", tool_name);
    Ok(())
}

/// Get the current config values for a specific tool (masks password fields).
#[tauri::command]
pub async fn user_tools_get_config(
    app: AppHandle,
    tool_name: String,
) -> Result<HashMap<String, Value>, String> {
    let tools_dir = user_tools_dir(&app)?;
    let safe_name = safe_tool_name(&tool_name);
    let tool_dir = tools_dir.join(&safe_name);

    let manifest = UserToolManifest::load(&tool_dir)
        .map_err(|e| format!("Tool '{}' not found: {}", tool_name, e))?;

    let settings = load_settings(&app)?;
    let raw = settings
        .user_tool_configs
        .get(&tool_name)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let mut result: HashMap<String, Value> = HashMap::new();
    if let Value::Object(map) = &raw {
        for (key, value) in map {
            let is_password = manifest
                .config_schema
                .get(key)
                .map(|s| s.field_type == "password")
                .unwrap_or(false);
            if is_password {
                result.insert(
                    key.clone(),
                    Value::String(if value.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                        "••••••••".into()
                    } else {
                        String::new()
                    }),
                );
            } else {
                result.insert(key.clone(), value.clone());
            }
        }
    }

    for (key, schema) in &manifest.config_schema {
        if !result.contains_key(key) {
            if let Some(default) = &schema.default {
                result.insert(key.clone(), default.clone());
            }
        }
    }

    Ok(result)
}

// ─── Private helpers ──────────────────────────────────────────────────────────

fn safe_tool_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

fn validate_manifest_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "unnamed" {
        return Err("manifest.json must declare a non-empty 'name' field".into());
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(format!("Invalid tool name: '{}'", name));
    }
    Ok(())
}

fn manifest_to_info(manifest: UserToolManifest, has_config: bool) -> UserToolInfo {
    UserToolInfo {
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        author: manifest.author,
        runtime: manifest.runtime,
        entrypoint: manifest.entrypoint,
        input_schema: manifest.input_schema,
        config_schema: manifest.config_schema,
        has_config,
    }
}

/// Recursively copy a directory.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Extract a zip archive into `target_dir`. Returns info about the tool found.
fn extract_zip(bytes: &[u8], target_dir: &Path) -> Result<UserToolInfo, String> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid zip: {}", e))?;

    let top_prefix = {
        let name = archive
            .by_index(0)
            .map_err(|e| e.to_string())?
            .name()
            .to_string();
        if name.contains('/') {
            name.split('/').next().unwrap_or("").to_string()
        } else {
            String::new()
        }
    };

    let mut manifest_opt: Option<UserToolManifest> = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = file.name().to_string();
        let relative = if !top_prefix.is_empty() && outpath.starts_with(&format!("{}/", top_prefix))
        {
            &outpath[top_prefix.len() + 1..]
        } else {
            &outpath
        };

        if relative.is_empty() {
            continue;
        }
        if relative.contains("..") {
            return Err(format!("Zip contains path traversal: '{}'", relative));
        }

        let target = target_dir.join("__temp__").join(relative);

        if file.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

            if relative == "manifest.json" || relative.ends_with("/manifest.json") {
                let text = String::from_utf8_lossy(&buf).to_string();
                match serde_json::from_str::<UserToolManifest>(&text) {
                    Ok(m) => manifest_opt = Some(m),
                    Err(e) => return Err(format!("Invalid manifest.json in zip: {}", e)),
                }
            }

            std::fs::write(&target, &buf).map_err(|e| e.to_string())?;
        }
    }

    let manifest = manifest_opt.ok_or("No manifest.json found in zip")?;
    validate_manifest_name(&manifest.name)?;

    let safe_name = safe_tool_name(&manifest.name);
    let tool_dir = target_dir.join(&safe_name);

    let temp_dir = target_dir.join("__temp__");
    if tool_dir.exists() {
        std::fs::remove_dir_all(&tool_dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp_dir, &tool_dir).map_err(|e| e.to_string())?;

    info!("Extracted user tool '{}' from zip", manifest.name);

    Ok(manifest_to_info(manifest, false))
}
