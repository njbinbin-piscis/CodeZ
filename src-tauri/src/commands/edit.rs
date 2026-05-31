//! Cmd-K inline edit — a focused, single-shot code transform.
//!
//! Unlike `chat_send` (the full agent loop with tools), this asks the LLM once
//! to rewrite a selection per an instruction and returns the replacement text
//! to the editor, which previews a diff and applies on accept. Fast and
//! side-effect free: nothing is written to disk by this command.

use tauri::AppHandle;

use pisci_kernel::headless;
use pisci_kernel::llm::{self, LlmMessage, LlmRequest, MessageContent};

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
        if base_url.is_empty() { None } else { Some(&base_url) },
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
