//! Teams (Phase 3) — installable Pool templates.
//!
//! A team manifest (`{config}/teams/<id>/team.json`) bundles an organization
//! contract (`org_spec`) with its member agents and a workflow. Creating a Pool
//! from a team syncs the member agents into the project's `kois` table, then
//! materialises a kernel `pool_sessions` row with the org_spec + members so the
//! main agent's `pool_org` / `pool_chat` tools can drive the collaboration.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tracing::{info, warn};

use crate::commands::agents::{safe_id, sync_agents_to_kois};
use crate::commands::data_scope::{open_project_kernel_state, resolve_global_config_dir};

// ─── Manifest schema ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Organization contract injected into the Pool (roles, rules, integration).
    #[serde(default)]
    pub org_spec: String,
    /// Member agent ids (slugs). Resolved to koi ids on pool creation.
    #[serde(default)]
    pub members: Vec<String>,
    /// Collaboration workflow hint: `waves` | `sequential` | `review`.
    #[serde(default = "default_workflow")]
    pub workflow: String,
    #[serde(default)]
    pub task_timeout_secs: u32,
}

fn default_workflow() -> String {
    "waves".to_string()
}

impl TeamManifest {
    fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("invalid team.json: {e}"))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub workflow: String,
    pub members: Vec<String>,
}

impl From<TeamManifest> for TeamInfo {
    fn from(m: TeamManifest) -> Self {
        Self {
            id: m.id,
            name: m.name,
            description: m.description,
            workflow: m.workflow,
            members: m.members,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PoolCreated {
    pub pool_id: String,
    pub name: String,
    pub member_koi_ids: Vec<String>,
}

// ─── Paths ───────────────────────────────────────────────────────────────────

fn teams_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_global_config_dir(app)?.join("teams"))
}

fn load_all(dir: &Path) -> Vec<TeamManifest> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("team.json").exists() {
                match TeamManifest::load(&p.join("team.json")) {
                    Ok(m) => out.push(m),
                    Err(e) => warn!("skip team at {}: {}", p.display(), e),
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn write_manifest(dir: &Path, manifest: &TeamManifest) -> Result<(), String> {
    let target = dir.join(safe_id(&manifest.id));
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(target.join("team.json"), pretty).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn teams_list(app: AppHandle) -> Result<Vec<TeamInfo>, String> {
    let dir = teams_dir(&app)?;
    Ok(load_all(&dir).into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn teams_get(app: AppHandle, id: String) -> Result<TeamManifest, String> {
    let dir = teams_dir(&app)?;
    TeamManifest::load(&dir.join(safe_id(&id)).join("team.json"))
}

#[tauri::command]
pub async fn teams_save(app: AppHandle, manifest: TeamManifest) -> Result<TeamInfo, String> {
    let dir = teams_dir(&app)?;
    let mut manifest = manifest;
    manifest.id = safe_id(&manifest.id);
    if manifest.id.is_empty() {
        return Err("team id must be a non-empty slug".into());
    }
    if manifest.name.trim().is_empty() {
        manifest.name = manifest.id.clone();
    }
    if manifest.workflow.trim().is_empty() {
        manifest.workflow = default_workflow();
    }
    write_manifest(&dir, &manifest)?;
    info!("Saved team '{}'", manifest.id);
    Ok(manifest.into())
}

#[tauri::command]
pub async fn teams_install(app: AppHandle, source: String) -> Result<TeamInfo, String> {
    let dir = teams_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let manifest_text = if source.starts_with("http://") || source.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .get(&source)
            .header("User-Agent", "CodeZ-Desktop/1.0")
            .send()
            .await
            .map_err(|e| format!("Download error: {e}"))?
            .text()
            .await
            .map_err(|e| format!("Read error: {e}"))?
    } else {
        let p = PathBuf::from(&source);
        let file = if p.is_dir() { p.join("team.json") } else { p };
        std::fs::read_to_string(&file).map_err(|e| e.to_string())?
    };

    let mut manifest: TeamManifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("invalid team.json: {e}"))?;
    manifest.id = safe_id(&manifest.id);
    if manifest.id.is_empty() {
        return Err("team.json must declare a non-empty 'id'".into());
    }
    write_manifest(&dir, &manifest)?;
    info!("Installed team '{}'", manifest.id);
    Ok(manifest.into())
}

#[tauri::command]
pub async fn teams_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let dir = teams_dir(&app)?;
    let target = dir.join(safe_id(&id));
    if !target.exists() {
        return Err(format!("team '{id}' not found"));
    }
    let canonical = target.canonicalize().map_err(|e| e.to_string())?;
    let base = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if !canonical.starts_with(&base) {
        return Err("path traversal blocked".into());
    }
    tokio::fs::remove_dir_all(&target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Materialise (or reuse) a Pool in the project DB from a team template.
/// Syncs member agents into `kois`, then creates/updates the pool_session with
/// the org_spec + members so the coordinator can dispatch to them.
#[tauri::command]
pub async fn teams_create_pool(
    app: AppHandle,
    project_dir: String,
    team_id: String,
) -> Result<PoolCreated, String> {
    let config_dir = resolve_global_config_dir(&app)?;
    let team = TeamManifest::load(&teams_dir(&app)?.join(safe_id(&team_id)).join("team.json"))?;
    let (db, _settings) = open_project_kernel_state(&app, &project_dir)?;

    let db = db.lock().await;

    // Ensure member agents exist as kois and resolve their koi ids.
    let synced = sync_agents_to_kois(&db, &config_dir);
    let mut member_koi_ids: Vec<String> = Vec::new();
    for member in &team.members {
        let slug = safe_id(member);
        let koi_id = synced
            .iter()
            .find(|a| safe_id(&a.id) == slug)
            .and_then(|a| a.koi_id.clone())
            .or_else(|| db.find_koi_by_name(&slug).ok().flatten().map(|k| k.id));
        match koi_id {
            Some(id) => member_koi_ids.push(id),
            None => warn!("team '{}' member '{}' has no koi", team.id, member),
        }
    }

    // Reuse an existing active pool with the same name, else create one.
    let existing = db
        .list_pool_sessions()
        .ok()
        .and_then(|pools| {
            pools
                .into_iter()
                .find(|p| p.name == team.name && p.status != "archived")
        });
    let pool = match existing {
        Some(p) => p,
        None => db
            .create_pool_session_with_dir(&team.name, Some(&project_dir), team.task_timeout_secs)
            .map_err(|e| e.to_string())?,
    };

    db.update_pool_org_spec(&pool.id, &team.org_spec)
        .map_err(|e| e.to_string())?;
    if team.task_timeout_secs > 0 {
        let _ = db.update_pool_session_config(&pool.id, Some(team.task_timeout_secs));
    }
    let _ = db.update_pool_session_dir(&pool.id, &project_dir);

    for koi_id in &member_koi_ids {
        if !db.is_pool_member(&pool.id, koi_id).unwrap_or(false) {
            if let Err(e) = db.add_pool_member(&pool.id, koi_id) {
                warn!("failed to add member {} to pool {}: {}", koi_id, pool.id, e);
            }
        }
    }

    info!(
        "Pool '{}' ready from team '{}' with {} members",
        pool.id,
        team.id,
        member_koi_ids.len()
    );
    Ok(PoolCreated {
        pool_id: pool.id,
        name: team.name,
        member_koi_ids,
    })
}
