//! Cmd-K inline edit — a focused, single-shot code transform.
//!
//! Unlike `chat_send` (the full agent loop with tools), this asks the LLM once
//! to rewrite a selection per an instruction and returns the replacement text
//! to the editor, which previews a diff and applies on accept. Fast and
//! side-effect free: nothing is written to disk by this command.

use tauri::AppHandle;

use piscis_kernel::headless;
use piscis_kernel::llm::{self, LlmMessage, LlmRequest, MessageContent};

use crate::commands::chat::resolve_config_dir;

const EDIT_SYSTEM_PROMPT: &str = "You are a precise code-editing assistant inside an IDE. \
Rewrite ONLY the user's selected code according to their instruction. \
Preserve surrounding style and indentation. \
Output just the replacement code — no explanations, no commentary, and no markdown code fences.";

/// Strip a single wrapping ```lang ... ``` fence if the model added one.
fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // drop the first line (``` or ```lang) and a trailing ```
        if let Some(nl) = rest.find('\n') {
            let body = &rest[nl + 1..];
            if let Some(end) = body.rfind("```") {
                return body[..end].trim_end_matches('\n').to_string();
            }
        }
    }
    t.to_string()
}

/// Produce a replacement for `selection` per `instruction`.
#[tauri::command]
pub async fn inline_edit(
    app: AppHandle,
    instruction: String,
    selection: String,
    language: Option<String>,
    before_context: Option<String>,
    after_context: Option<String>,
) -> Result<String, String> {
    let config_dir = resolve_config_dir(&app)?;
    let (_db, settings) = headless::open_kernel_state(&config_dir)
        .map_err(|e| format!("failed to initialise kernel state: {e}"))?;

    let (provider, model, api_key, base_url, read_timeout) = {
        let s = settings.lock().await;
        (
            s.provider.clone(),
            s.model.clone(),
            s.active_api_key().to_string(),
            s.custom_base_url.clone(),
            s.llm_read_timeout_secs.max(30),
        )
    };
    if api_key.is_empty() {
        return Err(format!("no API key configured for provider '{provider}'"));
    }

    let client = llm::build_client_with_timeout(
        &provider,
        &api_key,
        if base_url.is_empty() {
            None
        } else {
            Some(&base_url)
        },
        read_timeout,
    );

    let lang = language.unwrap_or_default();
    let before = before_context.unwrap_or_default();
    let after = after_context.unwrap_or_default();
    let user = format!(
        "Language: {lang}\n\n<context_before>\n{before}\n</context_before>\n\n\
         <selection>\n{selection}\n</selection>\n\n\
         <context_after>\n{after}\n</context_after>\n\n\
         Instruction: {instruction}\n\n\
         Return only the new code that should replace the <selection> block."
    );

    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".to_string(),
            content: MessageContent::text(&user),
        }],
        system: Some(EDIT_SYSTEM_PROMPT.to_string()),
        tools: Vec::new(),
        model,
        max_tokens: 4096,
        stream: false,
        vision_override: Some(false),
    };

    let resp = client
        .complete(req)
        .await
        .map_err(|e| format!("inline edit failed: {e}"))?;

    Ok(strip_code_fences(&resp.content))
}

const COMPLETION_SYSTEM_PROMPT: &str = "You are a code-completion engine (fill-in-the-middle). \
Given the code before the cursor (<prefix>) and after the cursor (<suffix>), output ONLY the \
text that should be inserted at the cursor to continue the code naturally. \
Do NOT repeat the prefix or the suffix. Do NOT add explanations or markdown fences. \
Output an empty string if no useful completion applies.";

/// Low-latency single-shot inline (Tab) completion (M5).
///
/// Routed to a dedicated `model_id` (the "completion model") when provided so a
/// fast/cheap model handles ghost-text while Chat keeps using the big model.
#[tauri::command]
pub async fn ai_inline_completion(
    app: AppHandle,
    prefix: String,
    suffix: String,
    language: Option<String>,
    model_id: Option<String>,
) -> Result<String, String> {
    if prefix.trim().is_empty() {
        return Ok(String::new());
    }
    let config_dir = resolve_config_dir(&app)?;
    let (_db, settings) = headless::open_kernel_state(&config_dir)
        .map_err(|e| format!("failed to initialise kernel state: {e}"))?;

    let (provider, model, api_key, base_url, read_timeout) = {
        let s = settings.lock().await;
        // Resolve the completion model when an id is given; else fall back to
        // the active provider/model.
        if let Some(p) = model_id
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .and_then(|id| s.find_llm_provider(id))
        {
            let key = {
                let k = p.effective_api_key();
                if k.trim().is_empty() {
                    s.active_api_key().to_string()
                } else {
                    k.to_string()
                }
            };
            (
                p.provider.clone(),
                p.model.clone(),
                key,
                p.base_url.clone(),
                s.llm_read_timeout_secs.max(15),
            )
        } else {
            (
                s.provider.clone(),
                s.model.clone(),
                s.active_api_key().to_string(),
                s.custom_base_url.clone(),
                s.llm_read_timeout_secs.max(15),
            )
        }
    };
    if api_key.is_empty() {
        return Ok(String::new()); // silently no-op when unconfigured
    }

    let client = llm::build_client_with_timeout(
        &provider,
        &api_key,
        if base_url.is_empty() {
            None
        } else {
            Some(&base_url)
        },
        read_timeout,
    );

    let lang = language.unwrap_or_default();
    // Cap context to keep latency low.
    let pfx = tail(&prefix, 2000);
    let sfx = head(&suffix, 600);
    let user = format!(
        "Language: {lang}\n\n<prefix>\n{pfx}\n</prefix>\n<suffix>\n{sfx}\n</suffix>\n\n\
         Insert the completion at the cursor (between prefix and suffix)."
    );

    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".to_string(),
            content: MessageContent::text(&user),
        }],
        system: Some(COMPLETION_SYSTEM_PROMPT.to_string()),
        tools: Vec::new(),
        model,
        max_tokens: 256,
        stream: false,
        vision_override: Some(false),
    };

    let resp = client
        .complete(req)
        .await
        .map_err(|e| format!("inline completion failed: {e}"))?;
    Ok(strip_code_fences(&resp.content))
}

fn tail(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().skip(s.chars().count() - max).collect()
}

fn head(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
