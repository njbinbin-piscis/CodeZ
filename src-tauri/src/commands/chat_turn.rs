//! AgentZ-specific agent turn runner — extends the headless kernel path with
//! runtime model override, vision attachment injection, and plan-mode tooling.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use tokio::sync::{mpsc, Mutex};

use piscis_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest, HeadlessCliResponse};
use piscis_kernel::agent::harness::config::{CompactionSettings, HarnessConfig};
use piscis_kernel::agent::messages::AgentEvent;
use piscis_kernel::agent::plan::PlanStore;
use piscis_kernel::agent::tool::{
    new_tool_registry_handle, ToolContext, ToolRegistry, ToolRegistryHandleExt,
};

use crate::browser::BrowserManager;
use crate::lsp::manager::LspManager;
use piscis_kernel::headless::KernelState;
use piscis_kernel::llm::{self, ContentBlock, LlmMessage, LlmRequest, MessageContent};
use piscis_kernel::policy::gate::PolicyGate;
use piscis_kernel::store::settings::{LlmProviderConfig, Settings};
use piscis_kernel::tools::NeutralToolsConfig;
use tauri::Emitter;
use tauri::Manager;

use super::agents::{safe_id, sync_agents_to_kois, AgentManifest};
use super::chat::FrontendAttachment;
use super::data_scope::resolve_global_config_dir;
use super::session::{
    first_chat_round_for_title, maybe_autotitle_session_from_first_prompt, persist_workz_meta,
    sanitize_llm_session_title, validate_session_continuation,
};
use super::session_sources::{default_channel_for, SOURCE_CODEZ};
use super::system_prompt::{
    agent_active_plan_context, agent_system_prompt, plan_mode_context, session_plan_rel_path,
    subagent_system_prompt, swarm_coordinator_append, swarm_coordinator_followup_reminder,
};
use super::teams::TeamManifest;

const PLAN_MODE_DISABLED: &[&str] = &[
    "file_write",
    "file_edit",
    "shell",
    "code_run",
    "process_control",
    "elevate",
    "email",
    "ssh",
    "web_search",
    "memory_store",
    "plan_todo",
];

#[derive(Debug, Clone)]
struct LlmRuntime {
    provider: String,
    model: String,
    api_key: String,
    base_url: String,
    max_tokens: u32,
}

#[derive(Debug, Clone)]
struct SettingsSnapshot {
    provider: String,
    model: String,
    custom_base_url: String,
    max_tokens: u32,
    anthropic_api_key: String,
    openai_api_key: String,
    deepseek_api_key: String,
    qwen_api_key: String,
    minimax_api_key: String,
    zhipu_api_key: String,
    kimi_api_key: String,
}

fn snapshot_settings(settings: &Settings) -> SettingsSnapshot {
    SettingsSnapshot {
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        custom_base_url: settings.custom_base_url.clone(),
        max_tokens: settings.max_tokens,
        anthropic_api_key: settings.anthropic_api_key.clone(),
        openai_api_key: settings.openai_api_key.clone(),
        deepseek_api_key: settings.deepseek_api_key.clone(),
        qwen_api_key: settings.qwen_api_key.clone(),
        minimax_api_key: settings.minimax_api_key.clone(),
        zhipu_api_key: settings.zhipu_api_key.clone(),
        kimi_api_key: settings.kimi_api_key.clone(),
    }
}

fn restore_settings(settings: &mut Settings, snap: SettingsSnapshot) {
    settings.provider = snap.provider;
    settings.model = snap.model;
    settings.custom_base_url = snap.custom_base_url;
    settings.max_tokens = snap.max_tokens;
    settings.anthropic_api_key = snap.anthropic_api_key;
    settings.openai_api_key = snap.openai_api_key;
    settings.deepseek_api_key = snap.deepseek_api_key;
    settings.qwen_api_key = snap.qwen_api_key;
    settings.minimax_api_key = snap.minimax_api_key;
    settings.zhipu_api_key = snap.zhipu_api_key;
    settings.kimi_api_key = snap.kimi_api_key;
}

fn set_provider_api_key(settings: &mut Settings, provider: &str, key: &str) {
    match provider {
        "openai" | "custom" | "ollama" => settings.openai_api_key = key.to_string(),
        "deepseek" => settings.deepseek_api_key = key.to_string(),
        "qwen" | "tongyi" => settings.qwen_api_key = key.to_string(),
        "minimax" => settings.minimax_api_key = key.to_string(),
        "zhipu" => settings.zhipu_api_key = key.to_string(),
        "kimi" | "moonshot" => settings.kimi_api_key = key.to_string(),
        _ => settings.anthropic_api_key = key.to_string(),
    }
}

pub(crate) fn apply_llm_provider(settings: &mut Settings, provider: &LlmProviderConfig) {
    settings.provider = provider.provider.clone();
    settings.model = provider.model.clone();
    settings.custom_base_url = provider.base_url.clone();
    if provider.max_tokens > 0 {
        settings.max_tokens = provider.max_tokens;
    }
    let key = provider.effective_api_key();
    if !key.trim().is_empty() {
        set_provider_api_key(settings, &provider.provider, key);
    }
}

const FAST_MODEL_HINTS: &[&str] = &[
    "mini", "fast", "flash", "haiku", "turbo", "small", "lite", "nano", "8b", "7b", "air",
];
const SMART_MODEL_HINTS: &[&str] = &[
    "opus", "pro", "max", "thinking", "reasoner", "o1", "o3", "405b", "70b", "large", "ultra",
];

/// Pick a configured model id by task tier when the caller didn't specify one
/// (M8 auto-routing). Plan mode (exploration) prefers a cheap/fast model; Agent
/// mode prefers a stronger one. Opt-in via `CODEZ_AUTO_MODEL_ROUTING=1` so the
/// default behaviour (active provider) is never silently overridden.
fn auto_route_model(settings: &Settings, chat_mode: &str) -> Option<String> {
    if std::env::var("CODEZ_AUTO_MODEL_ROUTING").ok().as_deref() != Some("1") {
        return None;
    }
    let hints = if chat_mode == "plan" {
        FAST_MODEL_HINTS
    } else {
        SMART_MODEL_HINTS
    };
    settings
        .llm_providers
        .iter()
        .find(|p| {
            let m = p.model.to_lowercase();
            hints.iter().any(|h| m.contains(h))
        })
        .map(|p| p.id.clone())
}

const SESSION_TITLE_SUMMARY_SYSTEM: &str =
    "You write very short chat session titles for a sidebar. \
Rules: 4–12 words; same language as the user message; describe the topic; \
no quotes; no trailing period; output ONLY the title on one line.";

fn clip_title_source(text: &str, max_chars: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max_chars {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max_chars).collect::<String>())
    }
}

async fn maybe_llm_rename_session_title(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<piscis_kernel::store::db::Database>>,
    settings: &Arc<Mutex<Settings>>,
    session_id: &str,
    event_sink: &Arc<dyn EventSink>,
) -> Result<()> {
    let (user_text, assistant_text) = {
        let guard = db.lock().await;
        first_chat_round_for_title(&guard, session_id)
    }
    .ok_or_else(|| anyhow!("session '{session_id}' is not a first chat round"))?;

    let (runtime, read_timeout) = {
        let s = settings.lock().await;
        let flash_id = resolve_global_config_dir(app)
            .ok()
            .and_then(|dir| crate::commands::flash::load_flash_provider_id(&dir));
        let flash = flash_id.filter(|id| s.find_llm_provider(id).is_some());
        let runtime =
            resolve_llm_runtime(&s, flash.as_deref()).or_else(|_| resolve_llm_runtime(&s, None))?;
        (runtime, s.llm_read_timeout_secs.max(30))
    };

    let client = llm::build_client_with_timeout(
        &runtime.provider,
        &runtime.api_key,
        if runtime.base_url.is_empty() {
            None
        } else {
            Some(&runtime.base_url)
        },
        read_timeout,
    );

    let user = format!(
        "User message:\n{}\n\nAssistant reply:\n{}\n\nTitle:",
        clip_title_source(&user_text, 600),
        clip_title_source(&assistant_text, 800),
    );
    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".into(),
            content: MessageContent::text(&user),
        }],
        system: Some(SESSION_TITLE_SUMMARY_SYSTEM.to_string()),
        tools: Vec::new(),
        model: runtime.model,
        max_tokens: 64,
        stream: false,
        vision_override: Some(false),
    };

    let resp = client
        .complete(req)
        .await
        .context("flash title summarize failed")?;
    let title = sanitize_llm_session_title(&resp.content);
    if title.is_empty() {
        return Ok(());
    }

    {
        let guard = db.lock().await;
        guard
            .rename_session(session_id, &title)
            .context("rename_session after title summarize failed")?;
    }
    event_sink.emit_session(
        session_id,
        "session_title",
        serde_json::json!({ "title": title }),
    );
    Ok(())
}

fn resolve_llm_runtime(settings: &Settings, model_id: Option<&str>) -> Result<LlmRuntime> {
    if let Some(id) = model_id.filter(|s| !s.trim().is_empty()) {
        let provider = settings
            .find_llm_provider(id)
            .ok_or_else(|| anyhow!("unknown model id '{id}'"))?;
        let api_key = {
            let key = provider.effective_api_key();
            if key.trim().is_empty() {
                settings.active_api_key().to_string()
            } else {
                key.to_string()
            }
        };
        if api_key.is_empty() {
            return Err(anyhow!("no API key configured for model '{id}'"));
        }
        return Ok(LlmRuntime {
            provider: provider.provider.clone(),
            model: provider.model.clone(),
            api_key,
            base_url: provider.base_url.clone(),
            max_tokens: if provider.max_tokens > 0 {
                provider.max_tokens
            } else {
                settings.max_tokens.max(1024)
            },
        });
    }

    // Legacy top-level provider/model — fall back to the first configured
    // llm_providers entry when the user only uses the multi-provider list.
    if settings.model.trim().is_empty() {
        if let Some(first) = settings.llm_providers.first() {
            let api_key = {
                let key = first.effective_api_key();
                if key.trim().is_empty() {
                    settings.active_api_key().to_string()
                } else {
                    key.to_string()
                }
            };
            if api_key.is_empty() {
                return Err(anyhow!(
                    "no API key configured for provider '{}'",
                    first.provider
                ));
            }
            return Ok(LlmRuntime {
                provider: first.provider.clone(),
                model: first.model.clone(),
                api_key,
                base_url: first.base_url.clone(),
                max_tokens: if first.max_tokens > 0 {
                    first.max_tokens
                } else {
                    settings.max_tokens.max(1024)
                },
            });
        }
    }

    let api_key = settings.active_api_key().to_string();
    if api_key.is_empty() {
        return Err(anyhow!(
            "no API key configured for provider '{}'",
            settings.provider
        ));
    }
    Ok(LlmRuntime {
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        api_key,
        base_url: settings.custom_base_url.clone(),
        max_tokens: settings.max_tokens.max(1024),
    })
}

/// Apply a provider id from `llm_providers` onto the mutable settings snapshot
/// that headless / Koi turns read via `settings.provider` + `settings.model`.
pub(crate) fn apply_model_id_to_settings(settings: &mut Settings, model_id: Option<&str>) {
    if let Some(id) = model_id.filter(|s| !s.trim().is_empty()) {
        if let Some(prov) = settings.find_llm_provider(id).cloned() {
            apply_llm_provider(settings, &prov);
        }
    }
}

/// Resolve which `llm_providers` id a Koi turn should run on: per-Koi binding,
/// else the global flash model, else the legacy default (caller may fall back
/// to the first configured provider when model is still empty).
pub(crate) fn resolve_koi_model_id(
    settings: &Settings,
    app: &tauri::AppHandle,
    koi_llm_provider_id: Option<&str>,
) -> Option<String> {
    if let Some(id) = koi_llm_provider_id.filter(|s| !s.trim().is_empty()) {
        if settings.find_llm_provider(id).is_some() {
            return Some(id.to_string());
        }
    }
    let flash_id = crate::commands::data_scope::resolve_global_config_dir(app)
        .ok()
        .and_then(|dir| crate::commands::flash::load_flash_provider_id(&dir));
    flash_id.filter(|id| settings.find_llm_provider(id).is_some())
}

/// Ensure headless consumers see a concrete provider/model on the settings mutex.
pub(crate) fn materialize_headless_llm_settings(
    settings: &mut Settings,
    app: &tauri::AppHandle,
    koi_llm_provider_id: Option<&str>,
) {
    let model_id = resolve_koi_model_id(settings, app, koi_llm_provider_id);
    apply_model_id_to_settings(settings, model_id.as_deref());
    if settings.model.trim().is_empty() {
        if let Some(first) = settings.llm_providers.first().cloned() {
            apply_llm_provider(settings, &first);
        }
    }
}

/// Fresh agent manifest → koi row sync, then resolve the Koi's bound provider id.
pub(crate) fn resolve_koi_llm_provider_for_turn(
    db: &piscis_kernel::store::db::Database,
    config_dir: &Path,
    koi_id: &str,
) -> Option<String> {
    let _ = sync_agents_to_kois(db, config_dir);
    let koi = db.get_koi(koi_id).ok().flatten()?;
    if let Some(pid) = koi.llm_provider_id.filter(|s| !s.trim().is_empty()) {
        return Some(pid);
    }
    let handle = safe_id(&koi.name);
    if handle.is_empty() {
        return None;
    }
    AgentManifest::load(&config_dir.join("agents").join(&handle).join("agent.json"))
        .ok()
        .and_then(|m| m.llm_provider_id)
        .filter(|s| !s.trim().is_empty())
}

/// Swarm coordinator must not silently fall back to the legacy global main model.
fn resolve_team_coordinator_model_id(
    app: &tauri::AppHandle,
    db: &piscis_kernel::store::db::Database,
    settings: &Settings,
    team_id: &str,
    config_dir: &Path,
) -> Option<String> {
    if let Some(flash) = resolve_global_config_dir(app)
        .ok()
        .and_then(|dir| crate::commands::flash::load_flash_provider_id(&dir))
    {
        if settings.find_llm_provider(&flash).is_some() {
            return Some(flash);
        }
    }

    let _ = sync_agents_to_kois(db, config_dir);

    if let Ok(team) = TeamManifest::load_by_id(app, team_id) {
        for member in &team.members {
            let slug = safe_id(member);
            if slug.is_empty() {
                continue;
            }
            if let Ok(Some(koi)) = db.find_koi_by_name(&slug) {
                if let Some(pid) = koi.llm_provider_id.filter(|s| !s.trim().is_empty()) {
                    if settings.find_llm_provider(&pid).is_some() {
                        return Some(pid);
                    }
                }
            }
            if let Ok(manifest) =
                AgentManifest::load(&config_dir.join("agents").join(&slug).join("agent.json"))
            {
                if let Some(pid) = manifest.llm_provider_id.filter(|s| !s.trim().is_empty()) {
                    if settings.find_llm_provider(&pid).is_some() {
                        return Some(pid);
                    }
                }
            }
        }
    }

    settings.llm_providers.first().map(|p| p.id.clone())
}

pub fn model_supports_vision(provider: &str, model: &str) -> bool {
    let m = model.to_lowercase();
    let p = provider.to_lowercase();
    if p == "openai" || p.contains("openai") {
        return m.contains("gpt-4o")
            || m.contains("gpt-4-vision")
            || m.contains("gpt-4-turbo")
            || m.contains("o1")
            || m.contains("o3")
            || m.contains("o4");
    }
    if p == "anthropic" || p.contains("claude") || m.contains("claude") {
        return m.contains("claude-3")
            || m.contains("claude-4")
            || m.contains("claude-opus")
            || m.contains("claude-sonnet")
            || m.contains("claude-haiku");
    }
    if p == "qwen" || p == "tongyi" || p.contains("qwen") {
        return m.contains("qwen-vl")
            || m.contains("qwen2-vl")
            || m.contains("qwen2.5-vl")
            || m.contains("qwen3-vl")
            || m.contains("qvq")
            || m.contains("qwen-omni")
            || m.contains("vl")
            || m.contains("vision");
    }
    if p == "kimi" || p == "moonshot" {
        return m.contains("vision") || m.contains("vl");
    }
    if p == "zhipu" {
        return m.contains("vision") || m.contains("vl") || m.contains("glm-4v");
    }
    if p == "minimax" {
        return m.contains("vision") || m.contains("vl");
    }
    false
}

pub fn resolve_attachment(
    prompt: &str,
    attachment: Option<FrontendAttachment>,
    vision_capable: bool,
) -> Result<(String, Option<(String, String)>)> {
    let Some(att) = attachment else {
        return Ok((prompt.to_string(), None));
    };

    if att.media_type.starts_with("image/") {
        if vision_capable {
            let data_b64 = if let Some(data) = att.data.filter(|d| !d.is_empty()) {
                data
            } else if let Some(path) = att.path.filter(|p| !p.is_empty()) {
                let bytes = std::fs::read(&path)
                    .with_context(|| format!("failed to read attachment at {path}"))?;
                base64::engine::general_purpose::STANDARD.encode(bytes)
            } else {
                return Err(anyhow!("image attachment requires data or path"));
            };
            return Ok((prompt.to_string(), Some((att.media_type, data_b64))));
        }

        let path_str = if let Some(p) = att.path.filter(|p| !p.is_empty()) {
            p
        } else if let Some(b64) = att.data.filter(|d| !d.is_empty()) {
            let ext = match att.media_type.as_str() {
                "image/png" => "png",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => "jpg",
            };
            let default_fname = format!("attachment.{ext}");
            let fname = att.filename.as_deref().unwrap_or(&default_fname);
            let tmp = std::env::temp_dir().join(fname);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .context("invalid base64 image data")?;
            std::fs::write(&tmp, &bytes).context("failed to write temp attachment")?;
            tmp.to_string_lossy().to_string()
        } else {
            String::new()
        };

        let effective = if path_str.is_empty() {
            prompt.to_string()
        } else if prompt.trim().is_empty() {
            format!("[Image saved to: {path_str}]")
        } else {
            format!("{prompt}\n[Attached image: {path_str}]")
        };
        return Ok((effective, None));
    }

    let path_str = if let Some(p) = att.path.filter(|p| !p.is_empty()) {
        p
    } else if let Some(b64) = att.data.filter(|d| !d.is_empty()) {
        let fname = att.filename.as_deref().unwrap_or("attachment.bin");
        let tmp = std::env::temp_dir().join(fname);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("invalid base64 attachment data")?;
        std::fs::write(&tmp, &bytes).context("failed to write temp attachment")?;
        tmp.to_string_lossy().to_string()
    } else {
        String::new()
    };

    let label = att.filename.as_deref().unwrap_or(&path_str);
    let effective = if path_str.is_empty() {
        prompt.to_string()
    } else if prompt.trim().is_empty() {
        format!("[Attached file: {label} at {path_str}]")
    } else {
        format!("{prompt}\n[Attached file: {label} at {path_str}]")
    };
    Ok((effective, None))
}

const MAX_FILE_REF_CHARS: usize = 12_000;
const MAX_TOTAL_REF_CHARS: usize = 48_000;

fn collect_at_refs(raw: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
            i += 1;
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if start < i {
                let path = &raw[start..i];
                if path.starts_with("browser-element(") || path.starts_with("terminal-snippet(") {
                    // Handled by dedicated expanders below.
                } else if !refs.iter().any(|p| p == path) {
                    refs.push(path.to_string());
                }
            }
        } else {
            i += 1;
        }
    }
    refs
}

fn read_ref_block(workspace_root: &str, ref_path: &str) -> Option<String> {
    let root = workspace_root.trim_end_matches(['/', '\\']);
    if root.is_empty() {
        return None;
    }
    let rel = ref_path.trim_start_matches(['/', '\\']);
    let full = PathBuf::from(root).join(rel);
    let meta = std::fs::metadata(&full).ok()?;
    if meta.is_dir() {
        return Some(format!(
            "[Directory `@{}` — not inlined. Use file_list / file_read.]",
            ref_path
        ));
    }
    let size = meta.len();
    let raw = std::fs::read(&full).ok()?;
    let is_binary = raw[..raw.len().min(8192)].contains(&0);
    if is_binary {
        return Some(format!(
            "[Binary file `@{}` — {} bytes, not inlined. Use file_read if needed.]",
            ref_path, size
        ));
    }
    let content = String::from_utf8_lossy(&raw).into_owned();
    let truncated = if content.len() > MAX_FILE_REF_CHARS {
        format!(
            "{}\n… [truncated, {} chars omitted]",
            &content[..MAX_FILE_REF_CHARS],
            content.len() - MAX_FILE_REF_CHARS
        )
    } else {
        content
    };
    Some(format!("```{ref_path}\n{truncated}\n```"))
}

/// Run a codebase search and format the top hits as an inline context block.
/// Used by the `@codebase` mention so the IDE chat can pull whole-repo recall
/// into a single turn (the agent can still call the `codebase_search` tool).
fn codebase_context_block(raw: &str, workspace_root: &str) -> Option<String> {
    let root = workspace_root.trim();
    if root.is_empty() {
        return None;
    }
    // Strip every `@token` so "codebase"/file names don't pollute the query.
    let query: String = raw
        .split_whitespace()
        .filter(|w| !w.starts_with('@'))
        .collect::<Vec<_>>()
        .join(" ");
    let hits =
        crate::commands::codebase::search_index(std::path::Path::new(root), &query, 8).ok()?;
    if hits.is_empty() {
        return None;
    }
    let mut block = String::from("Relevant code from @codebase search:\n");
    for h in hits {
        block.push_str(&format!(
            "\n```{}:{}-{}\n{}\n```\n",
            h.path, h.start_line, h.end_line, h.snippet
        ));
    }
    Some(block)
}

fn collect_browser_element_refs(raw: &str) -> Vec<String> {
    let needle = "@browser-element(";
    let mut refs = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = raw[i..].find(needle) {
        let open = i + rel + needle.len();
        if let Some(close_rel) = raw[open..].find(')') {
            let selector = raw[open..open + close_rel].trim();
            if !selector.is_empty() && !refs.iter().any(|s| s == selector) {
                refs.push(selector.to_string());
            }
            i = open + close_rel + 1;
        } else {
            break;
        }
    }
    refs
}

async fn expand_browser_element_refs(raw: &str, browser: &BrowserManager) -> String {
    let refs = collect_browser_element_refs(raw);
    if refs.is_empty() {
        return raw.to_string();
    }

    let browser_open = browser.is_open().await;
    let page_url = if browser_open {
        browser.current_url().await.unwrap_or_default()
    } else {
        String::new()
    };

    let mut blocks = Vec::new();
    for selector in refs {
        if !browser_open {
            blocks.push(format!(
                "[Browser element `@browser-element({selector})` — embedded browser is not open. \
                 Use the `browser` tool (get_text / eval) with selector `{selector}` on the live page.]"
            ));
            continue;
        }
        match browser.query_selector(&selector).await {
            Ok(Some(el)) => {
                let dom_path = if el.dom_path.is_empty() {
                    "(n/a)".to_string()
                } else {
                    el.dom_path.clone()
                };
                let react_component = if el.react_component.is_empty() {
                    "(n/a)".to_string()
                } else {
                    el.react_component.clone()
                };
                blocks.push(format!(
                    "Referenced browser element `@browser-element({selector})` on {page_url}:\n\
                     - Tag: {}\n\
                     - Selector: {}\n\
                     - DOM Path: {dom_path}\n\
                     - React Component: {react_component}\n\
                     - Position: {}×{} at ({}, {})\n\
                     - Text: {}\n\
                     - HTML:\n```html\n{}\n```\n\
                     (Re-query with the `browser` tool and selector `{selector}` for live updates.)",
                    el.tag,
                    el.selector,
                    el.rect_width,
                    el.rect_height,
                    el.rect_x,
                    el.rect_y,
                    el.text,
                    el.html,
                ));
            }
            Ok(None) => blocks.push(format!(
                "[Browser element `{selector}` not found on the current page ({page_url}).]"
            )),
            Err(e) => blocks.push(format!(
                "[Failed to query browser element `{selector}`: {e}]"
            )),
        }
    }

    format!(
        "Context from referenced browser elements:\n\n{}\n\n---\n\n{}",
        blocks.join("\n\n"),
        raw
    )
}

fn collect_terminal_snippet_refs(raw: &str) -> Vec<String> {
    let needle = "@terminal-snippet(";
    let mut refs = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = raw[i..].find(needle) {
        let open = i + rel + needle.len();
        if let Some(close_rel) = raw[open..].find(')') {
            let id = raw[open..open + close_rel].trim();
            if !id.is_empty() && !refs.iter().any(|s| s == id) {
                refs.push(id.to_string());
            }
            i = open + close_rel + 1;
        } else {
            break;
        }
    }
    refs
}

fn expand_terminal_snippets(
    raw: &str,
    snippets: &std::collections::HashMap<String, String>,
) -> String {
    let refs = collect_terminal_snippet_refs(raw);
    if refs.is_empty() {
        return raw.to_string();
    }
    let mut blocks = Vec::new();
    for id in refs {
        if let Some(text) = snippets.get(&id) {
            blocks.push(format!(
                "Terminal selection `@terminal-snippet({id})`:\n```\n{text}\n```"
            ));
        } else {
            blocks.push(format!(
                "[Terminal snippet `{id}` not found — it may have expired.]"
            ));
        }
    }
    format!(
        "Context from terminal selections:\n\n{}\n\n---\n\n{}",
        blocks.join("\n\n"),
        raw
    )
}

fn expand_file_refs(raw: &str, workspace_root: &str) -> String {
    let refs = collect_at_refs(raw);
    if refs.is_empty() {
        return raw.to_string();
    }
    tracing::info!(
        "expand_file_refs: {} @ref(s) in prompt (raw_len={}): {:?}",
        refs.len(),
        raw.len(),
        refs
    );
    let wants_codebase = refs.iter().any(|r| r == "codebase");
    let mut blocks = Vec::new();
    let mut total = 0usize;
    for ref_path in &refs {
        if ref_path == "codebase" {
            continue; // handled separately below
        }
        if total >= MAX_TOTAL_REF_CHARS {
            blocks.push(format!(
                "[Skipped remaining @file references — total inline limit ({MAX_TOTAL_REF_CHARS} chars) reached.]"
            ));
            break;
        }
        if let Some(block) = read_ref_block(workspace_root, ref_path) {
            tracing::info!(
                "expand_file_refs: inlined @{} → {} chars (total_so_far={})",
                ref_path,
                block.len(),
                total + block.len()
            );
            total += block.len();
            blocks.push(block);
        } else {
            tracing::info!(
                "expand_file_refs: @{} → skipped (not found or unreadable)",
                ref_path
            );
        }
    }
    if wants_codebase {
        if let Some(block) = codebase_context_block(raw, workspace_root) {
            tracing::info!("expand_file_refs: @codebase block → {} chars", block.len());
            blocks.push(block);
        }
    }
    if blocks.is_empty() {
        tracing::info!("expand_file_refs: no blocks produced, passing prompt through");
        return raw.to_string();
    }
    let out = format!(
        "Context from referenced files:\n\n{}\n\n---\n\n{}",
        blocks.join("\n\n"),
        raw
    );
    tracing::info!(
        "expand_file_refs: wrapped prompt → {} chars (blocks={})",
        out.len(),
        blocks.len()
    );
    out
}

fn build_tool_registry(
    app: tauri::AppHandle,
    db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    global_db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    config_dir: PathBuf,
    skill_loader: Arc<Mutex<crate::skills::loader::SkillLoader>>,
    settings: Arc<Mutex<Settings>>,
    event_sink: Arc<dyn EventSink>,
    plan_store: PlanStore,
    chat_mode: &str,
    lsp_manager: Arc<LspManager>,
    user_tools_dir: Option<PathBuf>,
    extra_enabled_tools: &[String],
    enable_pool: bool,
    enable_skill_manage: bool,
    loop_halt: Arc<std::sync::atomic::AtomicBool>,
    api_connector_allowlist: Option<Vec<String>>,
) -> ToolRegistry {
    let mut builtin_tool_enabled = None;
    if chat_mode == "plan" {
        let mut map = HashMap::new();
        for name in PLAN_MODE_DISABLED {
            map.insert((*name).to_string(), false);
        }
        builtin_tool_enabled = Some(map);
    }
    // User-selected skills can re-enable tools they need (e.g. a tool that plan
    // mode disabled). The map is an override (missing = enabled), so this only
    // ever expands the surface, never restricts it — except in Plan mode where
    // only `plan_write` may mutate files.
    if !extra_enabled_tools.is_empty() {
        let map = builtin_tool_enabled.get_or_insert_with(HashMap::new);
        const PLAN_MODE_WRITE_TOOLS: &[&str] = &[
            "file_write",
            "file_edit",
            "shell",
            "code_run",
            "process_control",
            "elevate",
            "email",
            "ssh",
            "memory_store",
            "plan_todo",
        ];
        for name in extra_enabled_tools {
            if chat_mode == "plan" && PLAN_MODE_WRITE_TOOLS.contains(&name.as_str()) {
                continue;
            }
            map.insert(name.clone(), true);
        }
    }

    // Phase 3: the main agent turn carries the pool wiring (in-process Koi
    // runtime + event sink) so `pool_org` / `pool_chat` register and team
    // (Pool) collaboration can fan out to member Koi. Sub-agent / plan
    // registries pass `enable_pool = false` to avoid recursion.
    let (subagent_runtime, pool_event_sink) = if enable_pool {
        let (rt, sink) = crate::runtime::koi::pool_wiring(&app);
        (Some(rt), Some(sink))
    } else {
        (None, None)
    };

    let mut handle = new_tool_registry_handle();
    let cfg = NeutralToolsConfig {
        db: Some(db),
        settings: Some(settings),
        builtin_tool_enabled,
        // ClawHub / user-authored executable tools live in `{config}/user-tools/`.
        user_tools_dir,
        event_sink: Some(event_sink),
        plan_store: Some(plan_store),
        pool_event_sink,
        subagent_runtime,
        coordinator_config: Default::default(),
    };
    let db_for_delegate = cfg.db.clone();
    let settings_for_delegate = cfg.settings.clone();
    let plan_for_delegate = cfg.plan_store.clone();
    piscis_kernel::tools::register_neutral_tools(&mut handle, &cfg);

    if let Some(registry) = handle.as_registry_mut() {
        registry.register(Box::new(crate::tools::LspTool {
            lsp_manager: lsp_manager.clone(),
        }));
        registry.register(Box::new(crate::tools::ReadLintsTool {
            lsp_manager: lsp_manager.clone(),
        }));
        registry.register(Box::new(crate::tools::codebase_search::CodebaseSearchTool));
        if let Ok(config_dir) = crate::commands::data_scope::resolve_global_config_dir(&app) {
            registry.register(Box::new(crate::tools::api_connector::ApiConnectorTool {
                config_dir,
                allowed_ids: api_connector_allowlist,
            }));
        }
        // SubAgent delegation (M7): only the main agent gets `delegate`; the
        // sub-agent's own (plan-mode) registry omits it to prevent recursion.
        // chat_ui + plan_mode_ui are available in Plan mode (brainstorm / build).
        registry.register(Box::new(crate::tools::chat_ui::ChatUiTool {
            app: app.clone(),
        }));
        registry.register(Box::new(crate::tools::chat_ui_patch::ChatUiPatchTool {
            app: app.clone(),
        }));
        registry.register(Box::new(crate::tools::chat_ui_listen::ChatUiListenTool {
            app: app.clone(),
        }));
        registry.register(Box::new(crate::tools::plan_mode_ui::PlanModeUiTool {
            app: app.clone(),
            loop_halt,
        }));
        if chat_mode == "plan" {
            if let (Some(db), Some(settings), Some(plan)) = (
                db_for_delegate.clone(),
                settings_for_delegate.clone(),
                plan_for_delegate.clone(),
            ) {
                registry.register(Box::new(crate::tools::delegate::DelegateTool {
                    db,
                    settings,
                    plan_store: plan,
                    lsp_manager: lsp_manager.clone(),
                    app: app.clone(),
                }));
            }
        }
        if chat_mode != "plan" {
            if let (Some(db), Some(settings), Some(plan)) =
                (db_for_delegate, settings_for_delegate, plan_for_delegate)
            {
                registry.register(Box::new(crate::tools::delegate::DelegateTool {
                    db: db.clone(),
                    settings: settings.clone(),
                    plan_store: plan.clone(),
                    lsp_manager: lsp_manager.clone(),
                    app: app.clone(),
                }));
                // Named, stateless Fish workers (Phase B). Like `delegate`, only
                // the main agent gets `call_fish`; sub-agents omit it.
                registry.register(Box::new(crate::tools::call_fish::CallFishTool {
                    db,
                    settings,
                    plan_store: plan,
                    lsp_manager,
                    app: app.clone(),
                }));
            }
            // Browser automation (CDP) — same RobotZ tool as openpiscis; drives the
            // page shown in the IDE Browser panel. Off in plan mode.
            {
                use tauri::Manager as _;
                let manager = app.state::<crate::state::AppState>().browser.shared();
                registry.register(Box::new(robotz_browser::BrowserTool::new(manager)));
                registry.register(Box::new(crate::tools::terminal_read::TerminalReadTool {
                    terminals: app.state::<crate::state::AppState>().terminals.clone(),
                }));
            }
            // App self-management: update settings, create assistants & teams.
            registry.register(Box::new(crate::tools::app_control::AppControlTool { app }));
            if enable_skill_manage {
                registry.register(Box::new(crate::tools::skill_manage::SkillManageTool {
                    db: global_db,
                    config_dir: config_dir.clone(),
                    loader: skill_loader,
                }));
            }
        }
    }

    handle
        .into_registry()
        .map_err(|_| "internal: tool registry handle type mismatch".to_string())
        .expect("tool registry")
}

/// A bounded, read-only tool registry for delegated sub-agents (M7). It mirrors
/// the main registry's read tools (explore + codebase_search + LSP) but omits
/// every write/exec tool and the `delegate` tool itself, so sub-agents cannot
/// mutate the workspace or recursively spawn more sub-agents.
fn build_subagent_registry(
    app: tauri::AppHandle,
    db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    settings: Arc<Mutex<Settings>>,
    event_sink: Arc<dyn EventSink>,
    plan_store: PlanStore,
    lsp_manager: Arc<LspManager>,
) -> ToolRegistry {
    let config_dir = resolve_global_config_dir(&app).unwrap_or_else(|_| PathBuf::from("."));
    let skills_root = crate::skills::service::skills_root_from_config_dir(&config_dir);
    let skill_loader = Arc::new(Mutex::new(crate::skills::loader::SkillLoader::new(
        skills_root,
    )));
    build_tool_registry(
        app,
        db.clone(),
        db,
        config_dir,
        skill_loader,
        settings,
        event_sink,
        plan_store,
        // "plan" mode disables writes / shell / code_run — exactly the
        // read-only surface we want a research sub-agent to have.
        "plan",
        lsp_manager,
        None,
        &[],
        false,
        false,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        None,
    )
}

/// Run a focused read-only research sub-agent in-process and return its final
/// summary text (M7 SubAgent delegation). Reuses the kernel agent loop with a
/// bounded iteration budget and timeout so the parent turn stays responsive.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_subagent_research(
    app: tauri::AppHandle,
    db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    settings: Arc<Mutex<Settings>>,
    plan_store: PlanStore,
    lsp_manager: Arc<LspManager>,
    workspace_root: String,
    task: String,
    cancel: Arc<AtomicBool>,
) -> Result<String> {
    let system_prompt = subagent_system_prompt(&workspace_root);
    run_subagent_with_prompt(
        app,
        db,
        settings,
        plan_store,
        lsp_manager,
        workspace_root,
        system_prompt,
        task,
        cancel,
    )
    .await
}

/// Core sub-agent runner shared by `delegate` (default research persona) and
/// `call_fish` (named Fish personas). Runs a bounded, read-only kernel agent
/// loop on the flash model and returns its final summary text.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_subagent_with_prompt(
    app: tauri::AppHandle,
    db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    settings: Arc<Mutex<Settings>>,
    plan_store: PlanStore,
    lsp_manager: Arc<LspManager>,
    workspace_root: String,
    system_prompt: String,
    task: String,
    cancel: Arc<AtomicBool>,
) -> Result<String> {
    // Prefer the global "flash" provider for sub-agents when configured and
    // still present; otherwise fall back to the main provider.
    let flash_id = crate::commands::data_scope::resolve_global_config_dir(&app)
        .ok()
        .and_then(|dir| crate::commands::flash::load_flash_provider_id(&dir));
    let runtime = {
        let s = settings.lock().await;
        let flash = flash_id.filter(|id| s.find_llm_provider(id).is_some());
        resolve_llm_runtime(&s, flash.as_deref())?
    };

    let registry = build_subagent_registry(
        app,
        db.clone(),
        settings.clone(),
        // A no-op sink: sub-agent events are summarised back to the parent as
        // the tool result rather than streamed to the UI as a separate turn.
        Arc::new(NullEventSink),
        plan_store,
        lsp_manager,
    );

    let (
        context_window,
        read_timeout,
        policy_mode,
        rate,
        allow_outside,
        threshold,
        fallback,
        compaction,
        tool_settings,
    ) = {
        let s = settings.lock().await;
        (
            s.context_window,
            s.llm_read_timeout_secs.max(30),
            s.policy_mode.clone(),
            s.tool_rate_limit_per_minute,
            s.allow_outside_workspace,
            s.auto_compact_input_tokens_threshold,
            s.fallback_models.clone(),
            CompactionSettings::from_settings(&s),
            Arc::new(piscis_kernel::agent::tool::ToolSettings::from_settings(&s)),
        )
    };

    let client = llm::build_client_with_timeout(
        &runtime.provider,
        &runtime.api_key,
        if runtime.base_url.is_empty() {
            None
        } else {
            Some(&runtime.base_url)
        },
        read_timeout,
    );

    let policy = Arc::new(PolicyGate::with_profile_and_flags(
        &workspace_root,
        &policy_mode,
        rate,
        allow_outside,
    ));

    let harness = HarnessConfig::for_scheduler(
        runtime.model.clone(),
        fallback,
        Arc::new(registry),
        policy,
        system_prompt,
        runtime.max_tokens,
        context_window,
        Some(false),
        threshold,
        compaction,
        db.clone(),
    );
    let agent = harness.into_agent_loop(client, None, None);

    let session_id = format!(
        "subagent-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let ctx = ToolContext {
        session_id: session_id.clone(),
        workspace_root: PathBuf::from(&workspace_root),
        bypass_permissions: true,
        settings: tool_settings,
        max_iterations: Some(10),
        memory_owner_id: "piscis".to_string(),
        pool_session_id: None,
        tool_use_id: None,
        cancel: cancel.clone(),
        loop_halt: None,
    };

    let messages = vec![LlmMessage {
        role: "user".into(),
        content: MessageContent::text(&task),
    }];

    let (tx, mut rx) = mpsc::channel::<AgentEvent>(256);
    let collector = tokio::spawn(async move {
        let mut text = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                AgentEvent::TextDelta { delta } => text.push_str(&delta),
                AgentEvent::Done { .. } => break,
                _ => {}
            }
        }
        text
    });

    let run_fut = agent.run(messages, tx, cancel.clone(), ctx);
    let run_res = tokio::time::timeout(Duration::from_secs(240), run_fut).await;
    let text = collector.await.unwrap_or_default();

    match run_res {
        Ok(Ok(_)) => Ok(text),
        Ok(Err(e)) => Err(anyhow!("sub-agent failed: {e}")),
        Err(_) => Ok(format!(
            "{text}\n\n[sub-agent timed out after 240s — partial findings above]"
        )),
    }
}

/// Event sink that discards everything — used by delegated sub-agents whose
/// progress is reported back as a single tool result, not a live UI stream.
struct NullEventSink;

impl EventSink for NullEventSink {
    fn emit_session(&self, _session_id: &str, _event: &str, _payload: serde_json::Value) {}
    fn emit_broadcast(&self, _event: &str, _payload: serde_json::Value) {}
}

fn inject_image_block(messages: &mut [LlmMessage], media_type: &str, data_b64: &str) {
    let image_block = ContentBlock::Image {
        source: llm::ImageSource {
            source_type: "base64".to_string(),
            media_type: media_type.to_string(),
            data: data_b64.to_string(),
        },
    };
    if let Some(last) = messages.last_mut() {
        if last.role == "user" {
            let text = last.content.as_text();
            let blocks = vec![ContentBlock::Text { text }, image_block];
            last.content = MessageContent::Blocks(blocks);
        }
    }
}

/// A parsed installed skill (SKILL.md + frontmatter), including its optional
/// `tools` / `mcp_servers` bindings (Phase 1).
pub(crate) struct SkillManifest {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: std::path::PathBuf,
    /// Builtin tool names this skill wants enabled while active.
    pub tools: Vec<String>,
    /// MCP server names (from `settings.mcp_servers`) this skill binds.
    pub mcp_servers: Vec<String>,
    /// Full SKILL.md body with the YAML frontmatter stripped.
    pub body: String,
}

/// Load installed + learned skills from quadrant storage.
pub(crate) fn load_installed_skills(config_dir: &std::path::Path) -> Vec<SkillManifest> {
    let root = crate::skills::service::skills_root_from_config_dir(config_dir);
    let mut loader = crate::skills::loader::SkillLoader::new(&root);
    let _ = loader.load_all();
    let mut out = Vec::new();
    for skill in loader.list_skills() {
        if skill.lifecycle != crate::skills::provenance::LIFECYCLE_INSTALLED
            && skill.lifecycle != crate::skills::provenance::LIFECYCLE_LEARNED
        {
            continue;
        }
        let skill_md = skill.source_path.join("SKILL.md");
        let slug = skill.skill_id.clone();
        out.push(SkillManifest {
            slug,
            name: skill.name.clone(),
            description: skill.description.clone(),
            path: skill_md,
            tools: skill.tools.clone(),
            mcp_servers: Vec::new(),
            body: skill.instructions.clone(),
        });
    }
    out.sort_by_key(|m| m.name.to_lowercase());
    out
}

/// True when `needle` matches a skill by slug or display name (case-insensitive).
fn skill_matches(skill: &SkillManifest, needle: &str) -> bool {
    needle.eq_ignore_ascii_case(&skill.slug) || needle.eq_ignore_ascii_case(&skill.name)
}

/// Build the "## ... skills" system block. With no `enabled` selection this is
/// progressive disclosure over every installed skill (list name + summary +
/// path). When the user selects skills for the conversation, only those are
/// injected — in full — with a strong directive to follow them.
fn skills_context(config_dir: &std::path::Path, enabled: &[String]) -> Option<String> {
    let skills = load_installed_skills(config_dir);
    if skills.is_empty() {
        return None;
    }

    if enabled.is_empty() {
        let lines: Vec<String> = skills
            .iter()
            .map(|s| {
                format!(
                    "- **{}** — {}\n  (read `{}` for full instructions before using)",
                    s.name,
                    s.description,
                    s.path.display()
                )
            })
            .collect();
        return Some(format!(
            "## Available skills\nYou have these installed skills. When a task matches one, \
             read its SKILL.md first, then follow it:\n{}",
            lines.join("\n")
        ));
    }

    let selected: Vec<&SkillManifest> = skills
        .iter()
        .filter(|s| enabled.iter().any(|e| skill_matches(s, e)))
        .collect();
    if selected.is_empty() {
        return None;
    }
    let blocks: Vec<String> = selected
        .iter()
        .map(|s| format!("### Skill: {}\n{}", s.name, s.body))
        .collect();
    Some(format!(
        "## Enabled skills (user-selected for this conversation)\nThe user explicitly \
         enabled these skills for this conversation. Follow their instructions \
         carefully and use the tools they prescribe:\n\n{}",
        blocks.join("\n\n---\n\n")
    ))
}

/// Read project rules from `{workspace}/.agentz/rules/` (preferred) or
/// `{workspace}/.cursor/rules/` (compat). Concatenates `*.md` / `*.mdc` into a
/// "## Project rules" block injected as a system constraint.
fn project_rules_context(workspace_root: &str) -> Option<String> {
    let root = std::path::Path::new(workspace_root.trim());
    if workspace_root.trim().is_empty() {
        return None;
    }
    let candidates = [
        root.join(".agentz").join("rules"),
        root.join(".cursor").join("rules"),
    ];
    let mut blocks = Vec::new();
    for dir in candidates.iter() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("md") | Some("mdc")
                )
            })
            .collect();
        files.sort();
        for f in files {
            if let Ok(content) = std::fs::read_to_string(&f) {
                if !content.trim().is_empty() {
                    blocks.push(content.trim().to_string());
                }
            }
        }
        if !blocks.is_empty() {
            break; // prefer the first dir that has rules
        }
    }
    if blocks.is_empty() {
        return None;
    }
    Some(format!("## Project rules\n{}", blocks.join("\n\n")))
}

/// When `.agentz/REPO_WIKI.md` exists, tell the agent where to read architecture context.
fn repo_wiki_context(workspace_root: &str) -> Option<String> {
    let root = std::path::Path::new(workspace_root.trim());
    if workspace_root.trim().is_empty() {
        return None;
    }
    let wiki = root.join(".agentz").join("REPO_WIKI.md");
    if !wiki.is_file() {
        return None;
    }
    Some(
        "## Repository wiki\n\
         A generated module/architecture overview is available at `.agentz/REPO_WIKI.md`. \
         Read it with `file_read` when you need repo structure, module layout, or onboarding context \
         (especially after the user generates or refreshes the Repo Wiki)."
            .to_string(),
    )
}

/// Load a short excerpt from the session plan file for Agent-mode context.
fn active_plan_excerpt(workspace_root: &str, session_id: &str) -> Option<(String, String)> {
    let rel = session_plan_rel_path(session_id);
    let abs = Path::new(workspace_root).join(&rel);
    let content = std::fs::read_to_string(&abs).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    let excerpt: String = content.chars().take(2400).collect();
    let excerpt = if content.chars().count() > 2400 {
        format!("{excerpt}\n…")
    } else {
        excerpt
    };
    Some((rel, excerpt))
}

pub async fn run_agentz_turn(
    app: tauri::AppHandle,
    mut request: HeadlessCliRequest,
    kernel: KernelState,
    event_sink: Arc<dyn EventSink>,
    plan_store: PlanStore,
    cancel: Arc<AtomicBool>,
    model_id: Option<String>,
    chat_mode: String,
    attachment: Option<FrontendAttachment>,
    clear_plan: bool,
    display_prompt: Option<String>,
    lsp_manager: Arc<LspManager>,
    browser: BrowserManager,
    journal: Arc<crate::journal::FileJournal>,
    config_dir: PathBuf,
    enabled_skills: Vec<String>,
    enabled_connectors: Option<Vec<String>>,
    agent_id: Option<String>,
    workz_team_id: Option<String>,
    workz_pool_id: Option<String>,
) -> Result<HeadlessCliResponse> {
    if !matches!(request.mode, HeadlessCliMode::Piscis) {
        return Err(anyhow!("AgentZ chat only supports mode=piscis"));
    }

    let (db, settings) = kernel;
    let chat_mode = if chat_mode == "plan" { "plan" } else { "agent" };

    let (global_db, _global_settings) =
        super::data_scope::open_global_kernel_state(&app).map_err(|e| anyhow!(e))?;
    let skills_root = crate::skills::service::skills_root_from_config_dir(&config_dir);
    let skill_loader = Arc::new(Mutex::new(crate::skills::loader::SkillLoader::new(
        skills_root.clone(),
    )));
    {
        let mut loader = skill_loader.lock().await;
        let _ = loader.load_all();
    }

    // Phase 2: a selected agent contributes its persona (system prompt), skills,
    // tools, MCP bindings, and optional model. Skills/tools/MCP fold into the
    // same wiring the composer skill selector uses.
    let agent = agent_id
        .as_deref()
        .and_then(|id| crate::commands::agents::resolve_agent(&config_dir, id));
    let mut enabled_skills = enabled_skills;
    if let Some(agent) = agent.as_ref() {
        for slug in &agent.skills {
            if !enabled_skills.iter().any(|s| s.eq_ignore_ascii_case(slug)) {
                enabled_skills.push(slug.clone());
            }
        }
    }

    // Auto-route to a fast/smart model by task tier when the caller left the
    // model unspecified (M8, opt-in via CODEZ_AUTO_MODEL_ROUTING).
    let model_id = match model_id.filter(|v| !v.trim().is_empty()) {
        Some(id) => Some(id),
        None => match agent
            .as_ref()
            .and_then(|a| a.llm_provider_id.clone())
            .filter(|v| !v.trim().is_empty())
        {
            Some(id) => Some(id),
            None => {
                if let Some(team_id) = workz_team_id.as_deref().filter(|s| !s.is_empty()) {
                    let guard = db.lock().await;
                    let s = settings.lock().await;
                    resolve_team_coordinator_model_id(&app, &guard, &s, team_id, &config_dir)
                } else {
                    let s = settings.lock().await;
                    auto_route_model(&s, chat_mode)
                }
            }
        },
    };

    let settings_snapshot = {
        let mut s = settings.lock().await;
        if let Some(id) = model_id.as_deref().filter(|v| !v.is_empty()) {
            let snap = snapshot_settings(&s);
            if let Some(prov) = s.find_llm_provider(id).cloned() {
                apply_llm_provider(&mut s, &prov);
            }
            Some(snap)
        } else {
            None
        }
    };

    let runtime = {
        let s = settings.lock().await;
        resolve_llm_runtime(&s, model_id.as_deref())?
    };

    let vision_capable = {
        let s = settings.lock().await;
        s.vision_enabled || model_supports_vision(&runtime.provider, &runtime.model)
    };

    let (effective_prompt, image_attachment) =
        resolve_attachment(&request.prompt, attachment, vision_capable)?;
    request.prompt = effective_prompt.clone();

    // Phase 1: skills the user selected for this conversation bind their
    // `tools` (re-enabled) and `mcp_servers` (registered even if globally off),
    // and have their full instructions injected below.
    let selected_skills: Vec<SkillManifest> = if enabled_skills.is_empty() {
        Vec::new()
    } else {
        load_installed_skills(&config_dir)
            .into_iter()
            .filter(|s| enabled_skills.iter().any(|e| skill_matches(s, e)))
            .collect()
    };
    let mut skill_enabled_tools: Vec<String> = selected_skills
        .iter()
        .flat_map(|s| s.tools.clone())
        .collect();
    let mut skill_mcp_names: std::collections::HashSet<String> = selected_skills
        .iter()
        .flat_map(|s| s.mcp_servers.clone())
        .collect();
    if let Some(agent) = agent.as_ref() {
        skill_enabled_tools.extend(agent.tools.iter().cloned());
        skill_mcp_names.extend(agent.mcp_servers.iter().cloned());
    }

    let loop_halt = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let api_connector_allowlist = enabled_connectors.clone();
    let mut registry = build_tool_registry(
        app.clone(),
        db.clone(),
        global_db.clone(),
        config_dir.clone(),
        skill_loader.clone(),
        settings.clone(),
        event_sink.clone(),
        plan_store.clone(),
        chat_mode,
        lsp_manager,
        Some(config_dir.join("user-tools")),
        &skill_enabled_tools,
        chat_mode != "plan",
        chat_mode == "agent",
        loop_halt.clone(),
        api_connector_allowlist,
    );
    // Register MCP server tools (M6) from settings.mcp_servers — async because
    // it connects to stdio/SSE servers. Plan mode keeps them (read-context).
    let mcp_servers = { settings.lock().await.mcp_servers.clone() };
    if !mcp_servers.is_empty() {
        piscis_kernel::tools::register_mcp_tools(&mut registry, &mcp_servers).await;
    }
    // A selected skill can bind an MCP server that is disabled globally; force
    // those on (without mutating saved settings) so the skill works this turn.
    if !skill_mcp_names.is_empty() {
        let bound: Vec<piscis_kernel::store::settings::McpServerConfig> = mcp_servers
            .iter()
            .filter(|m| !m.enabled && skill_mcp_names.contains(&m.name))
            .map(|m| {
                let mut c = m.clone();
                c.enabled = true;
                c
            })
            .collect();
        if !bound.is_empty() {
            piscis_kernel::tools::register_mcp_tools(&mut registry, &bound).await;
        }
    }
    // Connectors (Phase 0B): globally enabled services, unless the caller passed
    // an explicit allowlist (WorkZ generic agent). Named agents may also bind
    // their own connectors on top of the global pass.
    match &enabled_connectors {
        Some(ids) => {
            let selected =
                crate::commands::connectors::resolve_named_connector_mcp_configs(&config_dir, ids);
            if !selected.is_empty() {
                piscis_kernel::tools::register_mcp_tools(&mut registry, &selected).await;
            }
        }
        None => {
            let connector_configs =
                crate::commands::connectors::resolve_connector_mcp_configs(&config_dir);
            if !connector_configs.is_empty() {
                piscis_kernel::tools::register_mcp_tools(&mut registry, &connector_configs).await;
            }
            if let Some(agent) = agent.as_ref() {
                if !agent.connectors.is_empty() {
                    let already: std::collections::HashSet<String> = connector_configs
                        .iter()
                        .map(|c| c.name.clone())
                        .collect();
                    let agent_connectors: Vec<piscis_kernel::store::settings::McpServerConfig> =
                        crate::commands::connectors::resolve_named_connector_mcp_configs(
                            &config_dir,
                            &agent.connectors,
                        )
                        .into_iter()
                        .filter(|c| !already.contains(&c.name))
                        .collect();
                    if !agent_connectors.is_empty() {
                        piscis_kernel::tools::register_mcp_tools(&mut registry, &agent_connectors)
                            .await;
                    }
                }
            }
        }
    }
    let default_timeout = Duration::from_secs(600);

    // Resolve session id early so we can clear plan state before the turn.
    let workspace_root = request
        .workspace
        .clone()
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| {
            // block_on would be bad; read settings synchronously via already-held lock pattern
            String::new()
        });
    let workspace_root = if workspace_root.is_empty() {
        settings.lock().await.workspace_root.clone()
    } else {
        workspace_root
    };

    let display_for_db = display_prompt
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| request.prompt.clone());
    let with_browser = expand_browser_element_refs(&effective_prompt, &browser).await;
    let snippets = {
        use tauri::Manager as _;
        let snippets_map = app
            .state::<crate::state::AppState>()
            .terminal_snippets
            .clone();
        let guard = snippets_map.lock().await;
        guard.clone()
    };
    let with_terminal = expand_terminal_snippets(&with_browser, &snippets);
    let mut llm_user_content = expand_file_refs(&with_terminal, &workspace_root);

    let expected_source = request
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_channel_for(SOURCE_CODEZ).to_string());

    let session_id = match request.session_id.clone().filter(|s| !s.is_empty()) {
        Some(id) => {
            // A client may pre-generate the session id (so it can bind the
            // sidebar selection + stream filter before the turn returns). Only
            // validate cross-source continuation when the session already
            // exists; a brand-new id is created fresh under `expected_source`.
            let exists = {
                let guard = db.lock().await;
                guard
                    .get_session(&id)
                    .map_err(|e| anyhow!("get_session failed: {e}"))?
                    .is_some()
            };
            if exists {
                let guard = db.lock().await;
                validate_session_continuation(
                    &guard,
                    &id,
                    &expected_source,
                    workz_team_id.as_deref(),
                )
                .map_err(|e| anyhow!(e))?;
            }
            let title = request
                .session_title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("");
            let db = db.lock().await;
            db.ensure_fixed_session(&id, title, &expected_source)
                .context("failed to ensure requested session")?
                .id
        }
        None => {
            let title = request.session_title.as_deref();
            let db = db.lock().await;
            db.create_session_with_source(title, &expected_source)
                .context("failed to create session")?
                .id
        }
    };

    if workz_team_id.is_some() || workz_pool_id.is_some() {
        let guard = db.lock().await;
        persist_workz_meta(
            &guard,
            &session_id,
            workz_team_id.as_deref(),
            workz_pool_id.as_deref(),
        )
        .map_err(|e| anyhow!(e))?;
    }

    if clear_plan {
        let mut plans = plan_store.lock().await;
        plans.remove(&session_id);
    }

    {
        let db = db.lock().await;
        db.append_message(&session_id, "user", &display_for_db)
            .context("failed to append user message")?;
        let _ = db.update_session_status(&session_id, "running");
        let _ = maybe_autotitle_session_from_first_prompt(&db, &session_id, &display_for_db);
    }

    // WorkZ swarm follow-up: short coordinator reminder (org_spec stays in turn 1 history).
    if let (Some(_team_id), Some(pool_id)) = (
        workz_team_id.as_deref().filter(|s| !s.is_empty()),
        workz_pool_id.as_deref().filter(|s| !s.is_empty()),
    ) {
        let prior_user_turns = {
            let guard = db.lock().await;
            guard
                .get_messages_latest(&session_id, 2000)
                .unwrap_or_default()
                .into_iter()
                .filter(|m| m.role == "user")
                .count()
        };
        if prior_user_turns > 1 {
            let (open, blocked) = {
                let guard = db.lock().await;
                let todos = guard.list_koi_todos(None).unwrap_or_default();
                let mut open = 0u32;
                let mut blocked = 0u32;
                for t in todos.iter().filter(|t| t.pool_session_id.as_deref() == Some(pool_id))
                {
                    match t.status.as_str() {
                        "blocked" => blocked += 1,
                        "todo" | "in_progress" | "needs_review" => open += 1,
                        _ => {}
                    }
                }
                (open, blocked)
            };
            let reminder = swarm_coordinator_followup_reminder(pool_id, open, blocked);
            llm_user_content = format!("{reminder}\n\n{llm_user_content}");
        }
    }

    let (
        context_window,
        read_timeout,
        policy_mode,
        tool_rate_limit_per_minute,
        allow_outside_workspace,
        vision_enabled_setting,
        auto_compact_threshold,
        fallback_models,
        compaction,
        tool_settings,
        max_iterations,
    ) = {
        let s = settings.lock().await;
        (
            s.context_window,
            s.llm_read_timeout_secs.max(30),
            s.policy_mode.clone(),
            s.tool_rate_limit_per_minute,
            s.allow_outside_workspace,
            s.vision_enabled,
            s.auto_compact_input_tokens_threshold,
            s.fallback_models.clone(),
            CompactionSettings::from_settings(&s),
            Arc::new(piscis_kernel::agent::tool::ToolSettings::from_settings(&s)),
            s.max_iterations,
        )
    };

    // Host-side context assembly: reconstruct DB rows into real LlmMessages,
    // prepend the persisted rolling summary + state frame, and budget-trim —
    // instead of dumping raw rows and leaning entirely on in-loop compaction.
    let history_budget =
        piscis_kernel::llm::compute_context_budget(context_window, runtime.max_tokens);
    let mut llm_messages: Vec<LlmMessage> = {
        let db = db.lock().await;
        let history = db
            .get_messages_latest(&session_id, 2000)
            .unwrap_or_default();
        let rolling_summary = db
            .get_session_context_state(&session_id)
            .ok()
            .flatten()
            .map(|s| s.rolling_summary)
            .filter(|s| !s.trim().is_empty());
        let state_frame = db
            .get_session_state_frame_json(&session_id)
            .ok()
            .flatten()
            .and_then(|raw| piscis_kernel::agent::state_frame::StateFrame::from_json_opt(&raw));
        crate::context_assembly::build_context_messages(
            &history,
            history_budget,
            rolling_summary.as_deref(),
            state_frame.as_ref(),
        )
    };
    // The just-appended user row is the last message — overwrite it with the
    // enriched prompt (resolved @file refs etc.). Append if assembly produced
    // no trailing user turn (e.g. empty history).
    match llm_messages.last_mut() {
        Some(last) if last.role == "user" => {
            last.content = MessageContent::text(&llm_user_content);
        }
        _ => {
            llm_messages.push(LlmMessage {
                role: "user".into(),
                content: MessageContent::text(&llm_user_content),
            });
        }
    }

    if let Some((media_type, data_b64)) = image_attachment.as_ref() {
        inject_image_block(&mut llm_messages, media_type, data_b64);
    }

    let client = llm::build_client_with_timeout(
        &runtime.provider,
        &runtime.api_key,
        if runtime.base_url.is_empty() {
            None
        } else {
            Some(&runtime.base_url)
        },
        read_timeout,
    );

    // Compose extra system context: caller-supplied context + installed
    // ClawHub skills + project rules (M6).
    let mut extra_sections: Vec<String> = Vec::new();
    if let Some(existing) = request.extra_system_context.as_deref() {
        if !existing.trim().is_empty() {
            extra_sections.push(existing.to_string());
        }
    }
    if let Some(agent) = agent.as_ref() {
        if !agent.system_prompt.trim().is_empty() {
            extra_sections.push(format!(
                "## Active agent: {}\nYou are acting as this agent. Follow its role and \
                 instructions:\n{}",
                agent.name,
                agent.system_prompt.trim()
            ));
        }
    }
    if let Some(skills) = skills_context(&config_dir, &enabled_skills) {
        extra_sections.push(skills);
    }
    if let Some(ids) = enabled_connectors.as_ref() {
        if let Some(connectors) =
            crate::commands::connectors::connectors_prompt_context(&config_dir, ids)
        {
            extra_sections.push(connectors);
        }
    }
    if let Some(rules) = project_rules_context(&workspace_root) {
        extra_sections.push(rules);
    }
    if let Some(wiki) = repo_wiki_context(&workspace_root) {
        extra_sections.push(wiki);
    }
    if chat_mode == "plan" {
        let plan_path = session_plan_rel_path(&session_id);
        extra_sections.push(plan_mode_context(&plan_path));
    } else if let Some((plan_path, excerpt)) = active_plan_excerpt(&workspace_root, &session_id) {
        extra_sections.push(agent_active_plan_context(&plan_path, Some(&excerpt)));
    }
    if let (Some(team_id), Some(_pool_id)) = (
        workz_team_id.as_deref().filter(|s| !s.is_empty()),
        workz_pool_id.as_deref().filter(|s| !s.is_empty()),
    ) {
        if let Ok(team) = TeamManifest::load_by_id(&app, team_id) {
            let excerpt: String = team.org_spec.chars().take(2000).collect();
            let excerpt = if team.org_spec.chars().count() > 2000 {
                format!("{excerpt}…")
            } else {
                excerpt
            };
            extra_sections.push(swarm_coordinator_append(
                Some(excerpt.as_str()).filter(|s| !s.trim().is_empty()),
                &team.workflow_hint,
            ));
        }
    }
    // Run user-defined `beforeAgentTurn` hooks and inject their output as
    // additional system context (project hooks.json, M6+).
    if let Some(hook_ctx) =
        crate::commands::workbench::run_event_hooks(&workspace_root, "beforeAgentTurn").await
    {
        extra_sections.push(hook_ctx);
    }
    let combined_extra = if extra_sections.is_empty() {
        None
    } else {
        Some(extra_sections.join("\n\n"))
    };
    let system_prompt = agent_system_prompt(
        &workspace_root,
        allow_outside_workspace,
        combined_extra.as_deref(),
    );

    let policy = Arc::new(PolicyGate::with_profile_and_flags(
        &workspace_root,
        &policy_mode,
        tool_rate_limit_per_minute,
        allow_outside_workspace,
    ));

    let vision_override = vision_capable || vision_enabled_setting;
    let hooks: Arc<dyn piscis_kernel::agent::hooks::AgentHooks> =
        Arc::new(crate::runtime::journal_hooks::JournalWithIdeNotify::new(
            journal.clone(),
            app.clone(),
            Some(db.clone()),
        ));
    let harness = HarnessConfig::for_scheduler(
        runtime.model.clone(),
        fallback_models,
        Arc::new(registry),
        policy,
        system_prompt,
        runtime.max_tokens,
        context_window,
        Some(vision_override),
        auto_compact_threshold,
        compaction,
        db.clone(),
    )
    .with_hooks(hooks);
    let agent = harness.into_agent_loop(client, None, None);

    // Open a journal turn so before/after-tool hooks group this turn's file
    // snapshots together for Undo / replay.
    journal.begin_turn(&session_id);

    let workspace_buf = PathBuf::from(&workspace_root);
    let ctx = ToolContext {
        session_id: session_id.clone(),
        workspace_root: workspace_buf,
        bypass_permissions: true,
        settings: tool_settings,
        max_iterations: Some(max_iterations),
        memory_owner_id: "piscis".to_string(),
        pool_session_id: workz_pool_id
            .clone()
            .filter(|s| !s.trim().is_empty()),
        tool_use_id: None,
        cancel: cancel.clone(),
        loop_halt: Some(loop_halt),
    };

    let (tx, mut rx) = mpsc::channel::<AgentEvent>(1024);
    let collector_sink = event_sink.clone();
    let collector_session = session_id.clone();
    let collector_app = app.clone();
    let collector_workspace = workspace_root.clone();
    let collector = tokio::spawn(async move {
        let mut text = String::new();
        let mut errored: Option<String> = None;
        let mut tool_inputs: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        while let Some(event) = rx.recv().await {
            if let AgentEvent::ToolStart {
                ref id, ref input, ..
            } = event
            {
                tool_inputs.insert(id.clone(), input.clone());
            }
            // Bridge file-modifying tools → ide-file-changed with the real path
            // so the frontend reloads only affected tabs (watcher may lag).
            if let AgentEvent::ToolEnd {
                ref id,
                ref name,
                is_error,
                ..
            } = event
            {
                if matches!(name.as_str(), "file_write" | "file_edit") {
                    if let Some(input) = tool_inputs.remove(id) {
                        if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
                            let path_norm = path.replace('\\', "/");
                            if !path_norm.is_empty()
                                && path_norm != "."
                                && crate::path_filter::should_watch_path(&path_norm)
                            {
                                let _ = collector_app.emit(
                                    "ide-file-changed",
                                    serde_json::json!({
                                        "project_dir": collector_workspace,
                                        "path": path_norm,
                                        "kind": "modified",
                                    }),
                                );
                            }
                        }
                    }
                } else if name.as_str() == "browser" && !is_error {
                    if let Some(input) = tool_inputs.remove(id) {
                        let state = collector_app.state::<crate::state::AppState>();
                        state.browser_activity.mark_browser_tool().await;
                        crate::browser::events::emit_browser_changed(
                            &collector_app,
                            &input,
                            Some(collector_session.as_str()),
                        );
                    }
                } else {
                    tool_inputs.remove(id);
                }
            }
            if let Ok(payload) = serde_json::to_value(&event) {
                collector_sink.emit_session(&collector_session, "agent_event", payload);
            }
            match event {
                AgentEvent::TextDelta { delta } => text.push_str(&delta),
                AgentEvent::Error { message } => {
                    errored = Some(message);
                    break;
                }
                AgentEvent::Done { .. } => break,
                _ => {}
            }
        }
        (text, errored)
    });

    let timeout = match request.task_timeout_secs {
        Some(s) if s > 0 => Duration::from_secs(u64::from(s)),
        _ => default_timeout,
    };
    let run_fut = agent.run(llm_messages, tx, cancel.clone(), ctx);
    let run_res = tokio::time::timeout(timeout, run_fut).await;

    let (ok, new_messages, error_msg): (bool, Vec<LlmMessage>, Option<String>) = match run_res {
        Ok(Ok((msgs, _total_in, _total_out))) => (true, msgs, None),
        Ok(Err(e)) => (false, Vec::new(), Some(format!("agent error: {e}"))),
        Err(_) => {
            cancel.store(true, Ordering::SeqCst);
            (
                false,
                Vec::new(),
                Some(format!("timed out after {}s", timeout.as_secs())),
            )
        }
    };

    let (streamed_text, stream_error) = collector.await.unwrap_or_default();

    // Agent loop already persists via harness persistence; do not append
    // `new_messages` again or every turn is duplicated in the DB.

    let turn_failed = error_msg.is_some() || stream_error.is_some();
    if let Some(err) = error_msg.as_deref().or(stream_error.as_deref()) {
        event_sink.emit_session(
            &session_id,
            "agent_final",
            serde_json::json!({"ok": false, "error": err}),
        );
    } else {
        event_sink.emit_session(&session_id, "agent_final", serde_json::json!({"ok": true}));
    }

    // Reset the session status set to `running` at turn start so the sidebar
    // stops showing the live indicator once this turn ends. (Without this the
    // dot blinks forever because `task.status` stays `running` in the DB.)
    {
        let db = db.lock().await;
        let _ = db.update_session_status(&session_id, if turn_failed { "error" } else { "idle" });
    }

    if !turn_failed {
        let db_bg = db.clone();
        let settings_bg = settings.clone();
        let app_bg = app.clone();
        let session_bg = session_id.clone();
        let sink_bg = event_sink.clone();
        tokio::spawn(async move {
            if let Err(e) =
                maybe_llm_rename_session_title(&app_bg, &db_bg, &settings_bg, &session_bg, &sink_bg)
                    .await
            {
                tracing::debug!("session title summarize skipped: {e}");
            }
        });

        let project_db_ev = db.clone();
        let app_ev = app.clone();
        let session_ev = session_id.clone();
        let msgs_ev = new_messages.clone();
        let provider_ev = runtime.provider.clone();
        let api_key_ev = runtime.api_key.clone();
        let base_url_ev = if runtime.base_url.is_empty() {
            None
        } else {
            Some(runtime.base_url.clone())
        };
        let model_ev = runtime.model.clone();
        let max_tokens_ev = runtime.max_tokens;
        tokio::spawn(async move {
            crate::commands::post_turn::run_post_turn_hooks(
                &app_ev,
                project_db_ev,
                session_ev,
                msgs_ev,
                provider_ev,
                api_key_ev,
                base_url_ev,
                model_ev,
                max_tokens_ev,
            )
            .await;
        });
    }

    if let Some(snap) = settings_snapshot {
        let mut s = settings.lock().await;
        restore_settings(&mut s, snap);
    }

    let response_text = if !streamed_text.is_empty() {
        streamed_text
    } else {
        new_messages
            .iter()
            .rev()
            .find(|m| m.role == "assistant")
            .map(|m| m.content.as_text())
            .unwrap_or_default()
    };

    if let Some(err) = error_msg {
        return Err(anyhow!(err));
    }

    Ok(HeadlessCliResponse {
        ok,
        mode: HeadlessCliMode::Piscis.as_str().to_string(),
        session_id,
        pool_id: None,
        response_text,
        disabled_tools: Vec::new(),
        pool_wait: None,
    })
}
