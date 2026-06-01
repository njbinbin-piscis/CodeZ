//! CodeZ-specific agent turn runner — extends the headless kernel path with
//! runtime model override, vision attachment injection, and plan-mode tooling.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use tokio::sync::{mpsc, Mutex};

use pisci_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest, HeadlessCliResponse};
use pisci_kernel::agent::harness::config::{CompactionSettings, HarnessConfig};
use pisci_kernel::agent::messages::AgentEvent;
use pisci_kernel::agent::plan::PlanStore;
use pisci_kernel::agent::tool::{
    new_tool_registry_handle, ToolContext, ToolRegistry, ToolRegistryHandleExt,
};

use crate::lsp::manager::LspManager;
use pisci_kernel::headless::KernelState;
use pisci_kernel::llm::{self, ContentBlock, LlmMessage, MessageContent};
use pisci_kernel::policy::gate::PolicyGate;
use pisci_kernel::store::settings::{LlmProviderConfig, Settings};
use pisci_kernel::tools::NeutralToolsConfig;

use super::chat::FrontendAttachment;

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

fn apply_llm_provider(settings: &mut Settings, provider: &LlmProviderConfig) {
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
                if !refs.iter().any(|p| p == path) {
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

fn expand_file_refs(raw: &str, workspace_root: &str) -> String {
    let refs = collect_at_refs(raw);
    if refs.is_empty() {
        return raw.to_string();
    }
    let mut blocks = Vec::new();
    let mut total = 0usize;
    for ref_path in refs {
        if total >= MAX_TOTAL_REF_CHARS {
            blocks.push(format!(
                "[Skipped remaining @file references — total inline limit ({MAX_TOTAL_REF_CHARS} chars) reached.]"
            ));
            break;
        }
        if let Some(block) = read_ref_block(workspace_root, &ref_path) {
            total += block.len();
            blocks.push(block);
        }
    }
    if blocks.is_empty() {
        return raw.to_string();
    }
    format!(
        "Context from referenced files:\n\n{}\n\n---\n\n{}",
        blocks.join("\n\n"),
        raw
    )
}

fn plan_mode_context() -> &'static str {
    "## Plan Mode\n\
     You are in Plan mode. Understand the task, explore the codebase with read-only tools, \
     and maintain a visible execution plan using `plan_todo`.\n\
     - Prefer `file_read`, `file_list`, `file_search`, and `file_diff` to explore.\n\
     - Use `plan_todo` for multi-step work (usually 2-7 items).\n\
     - Do NOT modify files, run shell commands, or execute code unless the user explicitly \
       asks you to execute.\n"
}

fn build_tool_registry(
    db: Arc<Mutex<pisci_kernel::store::db::Database>>,
    settings: Arc<Mutex<Settings>>,
    event_sink: Arc<dyn EventSink>,
    plan_store: PlanStore,
    chat_mode: &str,
    lsp_manager: Arc<LspManager>,
) -> ToolRegistry {
    let mut builtin_tool_enabled = None;
    if chat_mode == "plan" {
        let mut map = HashMap::new();
        for name in PLAN_MODE_DISABLED {
            map.insert((*name).to_string(), false);
        }
        builtin_tool_enabled = Some(map);
    }

    let mut handle = new_tool_registry_handle();
    let cfg = NeutralToolsConfig {
        db: Some(db),
        settings: Some(settings),
        builtin_tool_enabled,
        user_tools_dir: None,
        event_sink: Some(event_sink),
        plan_store: Some(plan_store),
        pool_event_sink: None,
        subagent_runtime: None,
        coordinator_config: Default::default(),
    };
    pisci_kernel::tools::register_neutral_tools(&mut handle, &cfg);

    if let Some(registry) = handle.as_registry_mut() {
        registry.register(Box::new(crate::tools::lsp::LspTool {
            lsp_manager: lsp_manager.clone(),
        }));
        registry.register(Box::new(crate::tools::read_lints::ReadLintsTool {
            lsp_manager,
        }));
    }

    handle
        .into_registry()
        .map_err(|_| "internal: tool registry handle type mismatch".to_string())
        .expect("tool registry")
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
            let blocks = vec![
                ContentBlock::Text { text },
                image_block,
            ];
            last.content = MessageContent::Blocks(blocks);
        }
    }
}

fn headless_system_prompt(
    workspace_root: &str,
    allow_outside: bool,
    extra_context: Option<&str>,
) -> String {
    let today = chrono::Utc::now()
        .format("%Y-%m-%d (%A) %H:%M:%S UTC")
        .to_string();
    let workspace_line = if workspace_root.trim().is_empty() {
        String::new()
    } else {
        let note = if allow_outside {
            " (access outside this directory is also permitted when needed)"
        } else {
            " (file operations are restricted to this directory)"
        };
        format!("\nWorkspace: `{workspace_root}`{note}")
    };
    let extras = extra_context.map(str::trim).filter(|s| !s.is_empty());
    let mut body = format!(
        "You are Pisci, an AI coding assistant embedded in CodeZ.\n\
         Today's date: {today}{workspace_line}\n\n\
         ## Tool usage\n\
         - Prefer `file_list` / `file_read` / `file_search` to explore the workspace.\n\
         - Use `file_write` and `file_edit` for changes; `file_diff` to preview edits.\n\
         - Use `shell` for commands and `code_run` for build / test flows.\n\
         - Keep replies concise. Stop as soon as the requested task is done.\n"
    );
    if let Some(extra) = extras {
        body.push_str("\n## Extra context from caller\n");
        body.push_str(extra);
        body.push('\n');
    }
    body
}

pub async fn run_codez_turn(
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
    journal: Arc<crate::journal::FileJournal>,
) -> Result<HeadlessCliResponse> {
    if !matches!(request.mode, HeadlessCliMode::Pisci) {
        return Err(anyhow!("CodeZ chat only supports mode=pisci"));
    }

    let (db, settings) = kernel;
    let chat_mode = if chat_mode == "plan" { "plan" } else { "agent" };

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

    if chat_mode == "plan" {
        let extra = match request.extra_system_context.as_deref() {
            Some(existing) if !existing.trim().is_empty() => {
                format!("{existing}\n\n{}", plan_mode_context())
            }
            _ => plan_mode_context().to_string(),
        };
        request.extra_system_context = Some(extra);
    }

    let registry = build_tool_registry(
        db.clone(),
        settings.clone(),
        event_sink.clone(),
        plan_store.clone(),
        chat_mode,
        lsp_manager,
    );
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
    let llm_user_content = expand_file_refs(&effective_prompt, &workspace_root);

    let session_id = match request.session_id.clone().filter(|s| !s.is_empty()) {
        Some(id) => {
            let title = request.session_title.as_deref().unwrap_or(&id);
            let source = request.channel.as_deref().unwrap_or("codez");
            let db = db.lock().await;
            db.ensure_fixed_session(&id, title, source)
                .context("failed to ensure requested session")?
                .id
        }
        None => {
            let title = request.session_title.as_deref();
            let db = db.lock().await;
            db.create_session_with_source(title, "codez")
                .context("failed to create session")?
                .id
        }
    };

    if clear_plan {
        let mut plans = plan_store.lock().await;
        plans.remove(&session_id);
    }

    {
        let db = db.lock().await;
        db.append_message(&session_id, "user", &display_for_db)
            .context("failed to append user message")?;
        let _ = db.update_session_status(&session_id, "running");
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
            Arc::new(pisci_kernel::agent::tool::ToolSettings::from_settings(&s)),
            s.max_iterations,
        )
    };

    // Host-side context assembly: reconstruct DB rows into real LlmMessages,
    // prepend the persisted rolling summary + state frame, and budget-trim —
    // instead of dumping raw rows and leaning entirely on in-loop compaction.
    let history_budget =
        pisci_kernel::llm::compute_context_budget(context_window, runtime.max_tokens);
    let mut llm_messages: Vec<LlmMessage> = {
        let db = db.lock().await;
        let history = db.get_messages_latest(&session_id, 2000).unwrap_or_default();
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
            .and_then(|raw| pisci_kernel::agent::state_frame::StateFrame::from_json_opt(&raw));
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

    let system_prompt = headless_system_prompt(
        &workspace_root,
        allow_outside_workspace,
        request.extra_system_context.as_deref(),
    );

    let policy = Arc::new(PolicyGate::with_profile_and_flags(
        &workspace_root,
        &policy_mode,
        tool_rate_limit_per_minute,
        allow_outside_workspace,
    ));

    let vision_override = vision_capable || vision_enabled_setting;
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
    .with_hooks(journal.clone());
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
        memory_owner_id: "pisci".to_string(),
        pool_session_id: None,
        tool_use_id: None,
        cancel: cancel.clone(),
    };

    let (tx, mut rx) = mpsc::channel::<AgentEvent>(1024);
    let collector_sink = event_sink.clone();
    let collector_session = session_id.clone();
    let collector = tokio::spawn(async move {
        let mut text = String::new();
        let mut errored: Option<String> = None;
        while let Some(event) = rx.recv().await {
            if let Ok(payload) = serde_json::to_value(&event) {
                collector_sink.emit_session(&collector_session, "agent_event", payload);
            }
            match event {
                AgentEvent::TextDelta { delta } => text.push_str(&delta),
                AgentEvent::Error { message } => errored = Some(message),
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

    if let Some(err) = error_msg.as_deref().or(stream_error.as_deref()) {
        event_sink.emit_session(
            &session_id,
            "agent_final",
            serde_json::json!({"ok": false, "error": err}),
        );
    } else {
        event_sink.emit_session(
            &session_id,
            "agent_final",
            serde_json::json!({"ok": true}),
        );
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
        mode: HeadlessCliMode::Pisci.as_str().to_string(),
        session_id,
        pool_id: None,
        response_text,
        disabled_tools: Vec::new(),
        pool_wait: None,
    })
}
