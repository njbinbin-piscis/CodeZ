//! Fish — named, stateless sub-agent personas (the AgentZ take on OpenPiscis's
//! `fish`). A Fish is a self-contained worker the main agent invokes via the
//! `call_fish` tool for result-first jobs (scan, collect, summarize, extract)
//! whose intermediate steps should never touch the parent's context.
//!
//! Fish run on the global "flash" model (when configured) with the read-only
//! sub-agent tool surface, so their agent / tools / skills / connectors are all
//! global rather than per-conversation.
//!
//! Sources, highest priority last (later overrides earlier by id):
//! 1. Builtin library (this module).
//! 2. User-defined `{config}/FISH.toml`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::data_scope::resolve_global_config_dir;

/// Where a Fish definition came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FishSource {
    Builtin,
    User,
}

/// A single Fish persona.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FishDef {
    /// Stable identifier used by `call_fish`.
    pub id: String,
    /// Human-friendly name.
    pub name: String,
    /// One-line summary shown to the main agent when listing Fish.
    pub description: String,
    /// Persona / instructions appended to the read-only sub-agent guardrails.
    pub system_prompt: String,
    #[serde(default = "default_source")]
    pub source: FishSource,
}

fn default_source() -> FishSource {
    FishSource::User
}

/// Raw `FISH.toml` shape: `[[fish]]` array of tables.
#[derive(Debug, Default, Deserialize, Serialize)]
struct FishFile {
    #[serde(default)]
    fish: Vec<UserFish>,
}

#[derive(Debug, Deserialize, Serialize)]
struct UserFish {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    system_prompt: String,
}

/// Builtin Fish library — always available, no setup required.
pub fn builtin_fish() -> Vec<FishDef> {
    vec![
        FishDef {
            id: "scout".into(),
            name: "Scout".into(),
            description:
                "Map an area of the codebase: locate the files, modules, and entry points relevant to a topic and report where things live."
                    .into(),
            system_prompt:
                "You are Scout. Given a topic or feature, find where it lives in the workspace. \
                 Search broadly, then narrow down. Report a tight inventory: the key files (with \
                 line ranges), what each is responsible for, and the main entry points. Do not \
                 explain implementations in depth — just the map."
                    .into(),
            source: FishSource::Builtin,
        },
        FishDef {
            id: "summarizer".into(),
            name: "Summarizer".into(),
            description:
                "Read a file, module, or flow and return a concise explanation of how it works."
                    .into(),
            system_prompt:
                "You are Summarizer. Read the files named in the brief (and their close \
                 dependencies) and explain how the thing works: inputs, outputs, control flow, \
                 and notable edge cases. Keep it concise and reference exact paths + line ranges \
                 for every claim."
                    .into(),
            source: FishSource::Builtin,
        },
        FishDef {
            id: "extractor".into(),
            name: "Extractor".into(),
            description:
                "Collect specific, structured facts across the codebase (e.g. every route, every env var, all call sites of X)."
                    .into(),
            system_prompt:
                "You are Extractor. Collect the exact items the brief asks for across the whole \
                 workspace (e.g. all call sites, all routes, all config keys). Be exhaustive and \
                 precise. Return a flat, deduplicated list; each entry includes the file path and \
                 line number. Do not editorialize."
                    .into(),
            source: FishSource::Builtin,
        },
    ]
}

fn fish_file_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join("FISH.toml")
}

/// Parse user Fish from `{config}/FISH.toml`. Malformed files yield an empty
/// list rather than failing the whole library load.
pub fn load_user_fish(config_dir: &Path) -> Vec<FishDef> {
    let Ok(text) = std::fs::read_to_string(fish_file_path(config_dir)) else {
        return Vec::new();
    };
    let parsed: FishFile = match toml::from_str(&text) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    parsed
        .fish
        .into_iter()
        .filter_map(|u| {
            let id = u.id.trim().to_string();
            let prompt = u.system_prompt.trim().to_string();
            if id.is_empty() || prompt.is_empty() {
                return None;
            }
            let name = if u.name.trim().is_empty() {
                id.clone()
            } else {
                u.name.trim().to_string()
            };
            Some(FishDef {
                id,
                name,
                description: u.description.trim().to_string(),
                system_prompt: prompt,
                source: FishSource::User,
            })
        })
        .collect()
}

/// Full Fish library: builtin overlaid by user definitions (user wins on id).
pub fn load_fish_library(config_dir: &Path) -> Vec<FishDef> {
    let mut out = builtin_fish();
    for user in load_user_fish(config_dir) {
        if let Some(existing) = out.iter_mut().find(|f| f.id == user.id) {
            *existing = user;
        } else {
            out.push(user);
        }
    }
    out
}

/// Look up a single Fish by id from the full library.
pub fn find_fish(config_dir: &Path, id: &str) -> Option<FishDef> {
    let id = id.trim();
    load_fish_library(config_dir)
        .into_iter()
        .find(|f| f.id == id)
}

/// Id convention when an anonymous agent is created from an installed skill.
pub fn fish_id_for_skill_slug(slug: &str) -> String {
    format!("skill-{}", slug.trim())
}

/// User-defined anonymous agent derived from `slug`, if any.
pub fn find_user_fish_for_skill(config_dir: &Path, slug: &str) -> Option<FishDef> {
    let id = fish_id_for_skill_slug(slug);
    load_user_fish(config_dir)
        .into_iter()
        .find(|f| f.id == id)
}

/// List all available Fish (for the settings/management UI).
#[tauri::command]
pub async fn fish_list(app: AppHandle) -> Result<Vec<FishDef>, String> {
    let dir = resolve_global_config_dir(&app)?;
    Ok(load_fish_library(&dir))
}

fn read_user_fish_file(config_dir: &Path) -> FishFile {
    std::fs::read_to_string(fish_file_path(config_dir))
        .ok()
        .and_then(|t| toml::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_user_fish_file(config_dir: &Path, file: &FishFile) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let text = toml::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(fish_file_path(config_dir), text).map_err(|e| e.to_string())
}

/// Create or update a user Fish in `{config}/FISH.toml`. Builtin ids cannot be
/// shadowed silently — a user entry with a builtin id overrides it at runtime,
/// which is the intended customization path.
#[tauri::command]
pub async fn fish_save(
    app: AppHandle,
    id: String,
    name: String,
    description: String,
    system_prompt: String,
) -> Result<(), String> {
    let dir = resolve_global_config_dir(&app)?;
    let id = id.trim().to_string();
    let system_prompt = system_prompt.trim().to_string();
    if id.is_empty() {
        return Err("fish id is required".into());
    }
    if system_prompt.is_empty() {
        return Err("system_prompt is required".into());
    }
    let mut file = read_user_fish_file(&dir);
    let entry = UserFish {
        id: id.clone(),
        name: name.trim().to_string(),
        description: description.trim().to_string(),
        system_prompt,
    };
    if let Some(existing) = file.fish.iter_mut().find(|f| f.id == id) {
        *existing = entry;
    } else {
        file.fish.push(entry);
    }
    write_user_fish_file(&dir, &file)
}

/// Delete a user Fish from `{config}/FISH.toml`. Builtin Fish cannot be deleted.
#[tauri::command]
pub async fn fish_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = resolve_global_config_dir(&app)?;
    let id = id.trim();
    let mut file = read_user_fish_file(&dir);
    let before = file.fish.len();
    file.fish.retain(|f| f.id != id);
    if file.fish.len() == before {
        return Err(format!("no user fish with id '{id}'"));
    }
    write_user_fish_file(&dir, &file)
}
