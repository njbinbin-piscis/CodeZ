//! Agents (Phase 2) — installable single-Koi definitions.
//!
//! An agent is a curated persona: a system prompt plus the skills / tools / MCP
//! servers it should run with, and an optional model binding. Manifests live in
//! `{config}/agents/<id>/agent.json`. Selecting an agent in the composer runs
//! the conversation as that persona (its prompt + skills + tools are folded
//! into the turn, reusing the Phase 1 skill-binding machinery).
//!
//! Agents also mirror into the kernel `kois` table (per project DB) via
//! [`sync_agents_to_kois`] so team (Pool) collaboration can reference them as
//! members. The koi handle is the agent slug (whitespace/emoji-free, as the
//! kernel requires); the rich display name stays in the manifest.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tracing::{info, warn};

use crate::commands::data_scope::resolve_global_config_dir;

// ─── Manifest schema ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    /// Skill slugs to enable (full SKILL.md injected, like composer selection).
    #[serde(default)]
    pub skills: Vec<String>,
    /// Builtin tool names to ensure enabled while this agent runs.
    #[serde(default)]
    pub tools: Vec<String>,
    /// MCP server names (from settings) to bind even if globally disabled.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// Connector ids this agent additionally binds (registered even if the
    /// connector is globally disabled, as long as it is authorized).
    #[serde(default)]
    pub connectors: Vec<String>,
    /// Optional LLM provider id (from settings.llm_providers) to run as.
    #[serde(default)]
    pub llm_provider_id: Option<String>,
    #[serde(default)]
    pub max_iterations: u32,
    #[serde(default)]
    pub task_timeout_secs: u32,
    /// Kernel `kois.id` this agent last synced to (filled by sync). Stable
    /// reference for team membership.
    #[serde(default)]
    pub koi_id: Option<String>,
}

impl AgentManifest {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("invalid agent.json: {e}"))
    }
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub icon: String,
    pub color: String,
    pub description: String,
    pub skills: Vec<String>,
    pub tools: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub connectors: Vec<String>,
    pub llm_provider_id: Option<String>,
    pub koi_id: Option<String>,
}

impl From<AgentManifest> for AgentInfo {
    fn from(m: AgentManifest) -> Self {
        Self {
            id: m.id,
            name: m.name,
            role: m.role,
            icon: m.icon,
            color: m.color,
            description: m.description,
            skills: m.skills,
            tools: m.tools,
            mcp_servers: m.mcp_servers,
            connectors: m.connectors,
            llm_provider_id: m.llm_provider_id,
            koi_id: m.koi_id,
        }
    }
}

// ─── Paths ───────────────────────────────────────────────────────────────────

fn agents_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_global_config_dir(app)?.join("agents"))
}

pub(crate) fn safe_id(id: &str) -> String {
    let cleaned: String = id
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    cleaned.trim_matches('-').to_lowercase()
}

fn list_manifest_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("agent.json").exists() {
                dirs.push(p);
            }
        }
    }
    dirs
}

fn load_all_manifests(dir: &Path) -> Vec<AgentManifest> {
    let mut out = Vec::new();
    for mdir in list_manifest_dirs(dir) {
        match AgentManifest::load(&mdir.join("agent.json")) {
            Ok(m) => out.push(m),
            Err(e) => warn!("skip agent at {}: {}", mdir.display(), e),
        }
    }
    out.sort_by_key(|m| m.name.to_lowercase());
    out
}

/// Resolve a single agent manifest by id from the global config dir. Used by
/// the chat turn to fold the agent's persona / skills / tools into the run.
pub fn resolve_agent(config_dir: &Path, id: &str) -> Option<AgentManifest> {
    let path = config_dir.join("agents").join(safe_id(id)).join("agent.json");
    AgentManifest::load(&path).ok()
}

fn write_manifest(dir: &Path, manifest: &AgentManifest) -> Result<(), String> {
    let target = dir.join(safe_id(&manifest.id));
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(target.join("agent.json"), pretty).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── kois sync ───────────────────────────────────────────────────────────────

/// Mirror every installed agent manifest into the project's `kois` table so
/// teams can reference them as members. Matches by koi handle (the agent slug)
/// and updates in place, else creates. Returns the (possibly koi_id-updated)
/// manifests; callers persist them with [`persist_synced_koi_ids`].
pub fn sync_agents_to_kois(
    db: &piscis_kernel::store::db::Database,
    config_dir: &Path,
) -> Vec<AgentManifest> {
    let mut manifests = load_all_manifests(&config_dir.join("agents"));
    for manifest in manifests.iter_mut() {
        let handle = safe_id(&manifest.id);
        if handle.is_empty() {
            continue;
        }
        let role = if manifest.role.is_empty() {
            &manifest.name
        } else {
            &manifest.role
        };
        let existing = db.find_koi_by_name(&handle).ok().flatten();
        match existing {
            Some(koi) => {
                if let Err(e) = db.update_koi(
                    &koi.id,
                    None,
                    Some(role),
                    Some(&manifest.icon),
                    Some(&manifest.color),
                    Some(&manifest.system_prompt),
                    Some(&manifest.description),
                    Some(manifest.llm_provider_id.as_deref()),
                    Some(manifest.max_iterations),
                    Some(manifest.task_timeout_secs),
                ) {
                    warn!("failed to update koi for agent {}: {}", manifest.id, e);
                }
                manifest.koi_id = Some(koi.id);
            }
            None => match db.create_koi(
                &handle,
                role,
                &manifest.icon,
                &manifest.color,
                &manifest.system_prompt,
                &manifest.description,
                manifest.llm_provider_id.as_deref(),
                manifest.max_iterations,
                manifest.task_timeout_secs,
            ) {
                Ok(koi) => manifest.koi_id = Some(koi.id),
                Err(e) => warn!("failed to create koi for agent {}: {}", manifest.id, e),
            },
        }
    }
    manifests
}

/// Persist koi_id assignments back into each agent.json after a sync.
fn persist_synced_koi_ids(config_dir: &Path, manifests: &[AgentManifest]) {
    let dir = config_dir.join("agents");
    for m in manifests {
        if m.koi_id.is_some() {
            if let Err(e) = write_manifest(&dir, m) {
                warn!("failed to persist koi_id for agent {}: {}", m.id, e);
            }
        }
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn agents_list(app: AppHandle) -> Result<Vec<AgentInfo>, String> {
    let dir = agents_dir(&app)?;
    Ok(load_all_manifests(&dir).into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn agents_get(app: AppHandle, id: String) -> Result<AgentManifest, String> {
    let dir = agents_dir(&app)?;
    AgentManifest::load(&dir.join(safe_id(&id)).join("agent.json"))
}

/// Create or update an agent manifest (dev-mode Agent builder + edits).
#[tauri::command]
pub async fn agents_save(app: AppHandle, manifest: AgentManifest) -> Result<AgentInfo, String> {
    let dir = agents_dir(&app)?;
    let mut manifest = manifest;
    manifest.id = safe_id(&manifest.id);
    if manifest.id.is_empty() {
        return Err("agent id must be a non-empty slug".into());
    }
    if manifest.name.trim().is_empty() {
        manifest.name = manifest.id.clone();
    }
    write_manifest(&dir, &manifest)?;
    info!("Saved agent '{}'", manifest.id);
    Ok(manifest.into())
}

/// Install an agent from a local `agent.json` path/dir or an HTTPS URL.
#[tauri::command]
pub async fn agents_install(app: AppHandle, source: String) -> Result<AgentInfo, String> {
    let dir = agents_dir(&app)?;
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
            .header("User-Agent", "AgentZ-Desktop/1.0")
            .send()
            .await
            .map_err(|e| format!("Download error: {e}"))?
            .text()
            .await
            .map_err(|e| format!("Read error: {e}"))?
    } else {
        let p = PathBuf::from(&source);
        let file = if p.is_dir() { p.join("agent.json") } else { p };
        std::fs::read_to_string(&file).map_err(|e| e.to_string())?
    };

    let mut manifest: AgentManifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("invalid agent.json: {e}"))?;
    manifest.id = safe_id(&manifest.id);
    if manifest.id.is_empty() {
        return Err("agent.json must declare a non-empty 'id'".into());
    }
    manifest.koi_id = None;
    write_manifest(&dir, &manifest)?;
    info!("Installed agent '{}'", manifest.id);
    Ok(manifest.into())
}

#[tauri::command]
pub async fn agents_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let dir = agents_dir(&app)?;
    let target = dir.join(safe_id(&id));
    if !target.exists() {
        return Err(format!("agent '{id}' not found"));
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

/// Sync all agents into the given project's `kois` table (used before team /
/// pool operations and exposed for explicit refresh).
#[tauri::command]
pub async fn agents_sync(app: AppHandle, project_dir: String) -> Result<usize, String> {
    let config_dir = resolve_global_config_dir(&app)?;
    let (db, _settings) =
        crate::commands::data_scope::open_project_kernel_state(&app, &project_dir)?;
    let manifests = {
        let db = db.lock().await;
        sync_agents_to_kois(&db, &config_dir)
    };
    let count = manifests.iter().filter(|m| m.koi_id.is_some()).count();
    persist_synced_koi_ids(&config_dir, &manifests);
    Ok(count)
}

/// One builtin tool the agent allowlist can reference.
#[derive(Debug, Clone, Serialize)]
pub struct BuiltinToolInfo {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub group: String,
}

fn builtin_tool_catalog() -> Vec<BuiltinToolInfo> {
    const ROWS: &[(&str, &str, &str)] = &[
        ("file_read", "Read file contents", "files"),
        ("file_write", "Create or overwrite files", "files"),
        ("file_edit", "Apply structured edits to files", "files"),
        ("file_diff", "Show diffs between file versions", "files"),
        ("file_list", "List directory entries", "files"),
        ("file_search", "Search files by name/content", "files"),
        ("code_run", "Run code snippets in a sandbox", "exec"),
        ("shell", "Execute shell commands", "exec"),
        ("process_control", "List or stop OS processes", "exec"),
        ("web_search", "Search the web for links", "network"),
        ("web_fetch", "Fetch and read a URL as text", "network"),
        ("email", "Send email", "network"),
        ("ssh", "Run commands over SSH", "network"),
        ("memory_store", "Persist notes to agent memory", "memory"),
        ("recall_tool_result", "Recall a prior tool output", "memory"),
        ("vision_context", "Attach image context for vision models", "media"),
        ("pdf", "Extract text from PDF files", "media"),
        ("plan_todo", "Manage agent-mode todo list from plan steps", "plan"),
        ("plan_write", "Write structured plan markdown to .agentz/plans", "plan"),
        ("plan_mode_ui", "Plan mode entry/exit and brainstorm survey UI", "plan"),
        ("pool_org", "Organize swarm pool todos and members", "pool"),
        ("pool_chat", "Post messages to swarm pool board", "pool"),
        ("lsp", "LSP diagnostics, hover, definitions", "ide"),
        ("read_lints", "Read linter diagnostics for a file", "ide"),
        ("codebase_search", "Semantic search across the repo", "ide"),
        ("browser", "Automate the built-in browser panel", "ide"),
        ("terminal_read", "Read IDE terminal output", "ide"),
        ("delegate", "Spawn a read-only research sub-agent", "agent"),
        ("chat_ui", "Render interactive UI cards in chat", "ui"),
        ("chat_ui_patch", "Patch interactive UI card state", "ui"),
        ("chat_ui_listen", "Listen for UI card user actions", "ui"),
        ("api_connector", "Call configured HTTP API connectors", "connectors"),
    ];
    ROWS.iter()
        .map(|(id, hint, group)| BuiltinToolInfo {
            id: (*id).into(),
            label: (*id).into(),
            hint: (*hint).into(),
            group: (*group).into(),
        })
        .collect()
}

/// Return the catalog of builtin tools agents may whitelist.
#[tauri::command]
pub fn agents_list_builtin_tools() -> Vec<BuiltinToolInfo> {
    builtin_tool_catalog()
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use piscis_kernel::store::db::Database;
    use std::path::PathBuf;

    #[test]
    fn smoke_sync_seeded_agents_to_kois() {
        let home = std::env::var("HOME").expect("HOME");
        let config = PathBuf::from(home).join(".local/share/com.agentz.desktop");
        if !config.join("agents/architect/agent.json").exists() {
            eprintln!("skip: run app once to seed agents first");
            return;
        }

        let tmp = std::env::temp_dir().join(format!("agentz-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let db_dir = tmp.join(".agentz");
        std::fs::create_dir_all(&db_dir).expect("mkdir");
        let db = Database::open(&db_dir.join("piscis.db")).expect("open db");

        let synced = sync_agents_to_kois(&db, &config);
        assert_eq!(synced.len(), 5, "expected 5 seeded agents");
        for agent in &synced {
            assert!(agent.koi_id.is_some(), "missing koi_id for {}", agent.id);
        }

        let pool_members: Vec<String> = ["architect", "coder", "reviewer"]
            .iter()
            .map(|slug| {
                db.find_koi_by_name(slug)
                    .expect("find koi")
                    .expect("koi exists")
                    .id
            })
            .collect();
        assert_eq!(pool_members.len(), 3);

        let project_dir = tmp.to_string_lossy().into_owned();
        let pool = db
            .create_pool_session_with_dir("Smoke Fullstack Squad", Some(&project_dir), 0)
            .expect("create pool");
        db.update_pool_org_spec(&pool.id, "# smoke org_spec")
            .expect("org_spec");
        for koi_id in &pool_members {
            db.add_pool_member(&pool.id, koi_id).expect("add member");
        }
        assert_eq!(
            db.list_pool_members(&pool.id).expect("members").len(),
            3
        );
    }
}
