//! Workbench management commands — installed skills, project rules, and hooks.
//!
//! These power the unified Settings page tabs:
//! - **Skills**: list / uninstall packages under `{config}/skills/{slug}/`.
//! - **Rules**: CRUD on `{project}/.agentz/rules/*.md` (Cursor-style project rules).
//! - **Hooks**: read / write `{project}/.agentz/hooks.json` and test-run a hook.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::data_scope::resolve_global_config_dir;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct InstalledSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: String,
}

/// Parse `name` + `description` from a SKILL.md YAML frontmatter, falling back
/// to the first `# heading` / first non-empty line.
fn parse_skill_meta(content: &str, fallback: &str) -> (String, String) {
    let mut name = fallback.to_string();
    let mut desc = String::new();
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    let n = v.trim().trim_matches('"').trim_matches('\'');
                    if !n.is_empty() {
                        name = n.to_string();
                    }
                } else if let Some(v) = line.strip_prefix("description:") {
                    let d = v.trim().trim_matches('"').trim_matches('\'');
                    if !d.is_empty() {
                        desc = d.to_string();
                    }
                }
            }
        }
    }
    if desc.is_empty() {
        desc = content
            .lines()
            .find(|l| !l.trim().is_empty() && !l.starts_with("---") && !l.starts_with('#'))
            .unwrap_or("")
            .trim()
            .chars()
            .take(160)
            .collect();
    }
    (name, desc)
}

fn sanitize_slug(slug: &str) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
        || slug.contains("..")
    {
        return Err(format!("invalid skill slug: '{slug}'"));
    }
    Ok(slug.to_string())
}

/// List skills installed under `{config}/skills/*/SKILL.md`.
#[tauri::command]
pub fn skills_list_installed(app: AppHandle) -> Result<Vec<InstalledSkill>, String> {
    let config_dir = resolve_global_config_dir(&app)?;
    let skills_root = config_dir.join("skills");
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&skills_root) {
        Ok(e) => e,
        Err(_) => return Ok(out), // no skills installed yet
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&skill_md) else {
            continue;
        };
        let slug = entry.file_name().to_string_lossy().to_string();
        let (name, description) = parse_skill_meta(&content, &slug);
        out.push(InstalledSkill {
            slug,
            name,
            description,
            path: skill_md.display().to_string(),
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Remove an installed skill directory under `{config}/skills/{slug}/`.
#[tauri::command]
pub fn skills_uninstall(app: AppHandle, slug: String) -> Result<(), String> {
    let slug = sanitize_slug(&slug)?;
    let config_dir = resolve_global_config_dir(&app)?;
    let skill_dir = config_dir.join("skills").join(&slug);
    if !skill_dir.is_dir() {
        return Err(format!("skill not found: {slug}"));
    }
    std::fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Project rules (Cursor-style)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RuleFile {
    pub name: String,
    pub enabled: bool,
    pub size: u64,
    pub path: String,
}

/// `{project}/.agentz/rules`
fn rules_dir(project_dir: &str) -> Result<PathBuf, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return Err("project directory is empty".to_string());
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(format!("project directory not found: {trimmed}"));
    }
    Ok(root.join(".agentz").join("rules"))
}

/// Reject names that escape the rules directory.
fn safe_rule_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("invalid rule name: '{name}'"));
    }
    Ok(name.to_string())
}

/// A rule file is "enabled" when it ends in `.md`/`.mdc`; disabled rules carry a
/// trailing `.disabled` so the agent's rule loader skips them.
fn rule_is_enabled(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".mdc")
}

/// List rule files under `{project}/.agentz/rules/`.
#[tauri::command]
pub fn rules_list(project_dir: String) -> Result<Vec<RuleFile>, String> {
    let dir = rules_dir(&project_dir)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_rule = lower.ends_with(".md")
            || lower.ends_with(".mdc")
            || lower.ends_with(".md.disabled")
            || lower.ends_with(".mdc.disabled");
        if !is_rule {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(RuleFile {
            enabled: rule_is_enabled(&name),
            name,
            size,
            path: path.display().to_string(),
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Read the contents of a single rule file.
#[tauri::command]
pub fn rules_read(project_dir: String, name: String) -> Result<String, String> {
    let dir = rules_dir(&project_dir)?;
    let name = safe_rule_name(&name)?;
    std::fs::read_to_string(dir.join(&name)).map_err(|e| e.to_string())
}

/// Create or overwrite a rule file. A `.md` extension is appended when missing.
#[tauri::command]
pub fn rules_write(project_dir: String, name: String, content: String) -> Result<String, String> {
    let dir = rules_dir(&project_dir)?;
    let mut name = safe_rule_name(&name)?;
    let lower = name.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".mdc")) {
        name.push_str(".md");
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), content).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Delete a rule file.
#[tauri::command]
pub fn rules_delete(project_dir: String, name: String) -> Result<(), String> {
    let dir = rules_dir(&project_dir)?;
    let name = safe_rule_name(&name)?;
    let path = dir.join(&name);
    if !path.is_file() {
        return Err(format!("rule not found: {name}"));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle a rule on/off by adding/removing a trailing `.disabled` suffix.
#[tauri::command]
pub fn rules_set_enabled(
    project_dir: String,
    name: String,
    enabled: bool,
) -> Result<String, String> {
    let dir = rules_dir(&project_dir)?;
    let name = safe_rule_name(&name)?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("rule not found: {name}"));
    }
    let currently_enabled = rule_is_enabled(&name);
    if currently_enabled == enabled {
        return Ok(name);
    }
    let new_name = if enabled {
        name.trim_end_matches(".disabled").to_string()
    } else {
        format!("{name}.disabled")
    };
    let dst = dir.join(&new_name);
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(new_name)
}

// ---------------------------------------------------------------------------
// Hooks (Cursor-style hooks.json)
// ---------------------------------------------------------------------------

/// A single user-defined hook: a shell command run on a lifecycle event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// One of: `beforeAgentTurn`, `afterAgentTurn`, `beforeFileEdit`, `afterFileEdit`.
    pub event: String,
    pub command: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub hooks: Vec<HookDef>,
}

fn default_version() -> u32 {
    1
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            version: 1,
            hooks: Vec::new(),
        }
    }
}

/// `{project}/.agentz/hooks.json`
fn hooks_path(project_dir: &str) -> Result<PathBuf, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return Err("project directory is empty".to_string());
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(format!("project directory not found: {trimmed}"));
    }
    Ok(root.join(".agentz").join("hooks.json"))
}

const HOOK_EVENTS: &[&str] = &[
    "beforeAgentTurn",
    "afterAgentTurn",
    "beforeFileEdit",
    "afterFileEdit",
];

/// Read the project hooks config (returns an empty config when absent).
#[tauri::command]
pub fn hooks_get(project_dir: String) -> Result<HooksConfig, String> {
    let path = hooks_path(&project_dir)?;
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(HooksConfig::default());
    };
    if raw.trim().is_empty() {
        return Ok(HooksConfig::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("invalid hooks.json: {e}"))
}

/// Persist the project hooks config to `{project}/.agentz/hooks.json`.
#[tauri::command]
pub fn hooks_save(project_dir: String, config: HooksConfig) -> Result<(), String> {
    for hook in &config.hooks {
        if !HOOK_EVENTS.contains(&hook.event.as_str()) {
            return Err(format!("unknown hook event: {}", hook.event));
        }
    }
    let path = hooks_path(&project_dir)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct HookRunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Test-run a hook command in the project directory (10s timeout).
#[tauri::command]
pub async fn hooks_run(project_dir: String, command: String) -> Result<HookRunResult, String> {
    let trimmed_dir = project_dir.trim();
    if trimmed_dir.is_empty() || !Path::new(trimmed_dir).is_dir() {
        return Err(format!("project directory not found: {trimmed_dir}"));
    }
    run_hook_command(trimmed_dir, &command)
        .await
        .map_err(|e| e.to_string())
}

/// Spawn a shell command rooted at `cwd`, capturing stdout/stderr with a timeout.
pub async fn run_hook_command(cwd: &str, command: &str) -> Result<HookRunResult, std::io::Error> {
    use tokio::process::Command;

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };

    cmd.current_dir(cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd.spawn()?;
    let out =
        match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
            .await
        {
            Ok(res) => res?,
            Err(_) => {
                return Ok(HookRunResult {
                    exit_code: -1,
                    stdout: String::new(),
                    stderr: "hook timed out after 10s".to_string(),
                });
            }
        };

    Ok(HookRunResult {
        exit_code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Run all enabled hooks for `event` and return their combined stdout as a
/// system-prompt section, or `None` when there's nothing to inject. Failures
/// are swallowed so a misconfigured hook never breaks an agent turn.
pub async fn run_event_hooks(workspace_root: &str, event: &str) -> Option<String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_dir() {
        return None;
    }
    let config = hooks_get(trimmed.to_string()).ok()?;
    let mut blocks: Vec<String> = Vec::new();
    for hook in config
        .hooks
        .iter()
        .filter(|h| h.enabled && h.event == event)
    {
        if hook.command.trim().is_empty() {
            continue;
        }
        if let Ok(res) = run_hook_command(trimmed, &hook.command).await {
            let label = if hook.name.trim().is_empty() {
                hook.id.clone()
            } else {
                hook.name.clone()
            };
            let body = res.stdout.trim();
            if !body.is_empty() {
                blocks.push(format!("### {label}\n{body}"));
            }
        }
    }
    if blocks.is_empty() {
        return None;
    }
    Some(format!(
        "## Hook output ({event})\nThe following context was produced by project hooks:\n{}",
        blocks.join("\n\n")
    ))
}
