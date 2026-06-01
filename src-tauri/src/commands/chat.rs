//! AI chat command — drives a single agent turn on the shared `pisci-engine`
//! kernel and streams [`AgentEvent`]s back to the frontend.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use pisci_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest};

use crate::commands::chat_turn::run_codez_turn;
use crate::commands::data_scope::{open_project_kernel_state, require_project_dir, SESSION_SOURCE};
use crate::state::AppState;

/// Re-export for settings / inline edit (always global config dir).
pub(crate) use crate::commands::data_scope::resolve_global_config_dir as resolve_config_dir;

/// Tauri event channel that carries every streamed kernel event to the UI.
pub const CHAT_EVENT: &str = "codez:chat-event";

/// Attachment sent from the frontend with a chat message.
#[derive(Debug, Clone, Deserialize)]
pub struct FrontendAttachment {
    pub media_type: String,
    pub path: Option<String>,
    pub data: Option<String>,
    pub filename: Option<String>,
}

/// Bridges the kernel's [`EventSink`] to Tauri events.
struct TauriEventSink {
    app: AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit_session(&self, session_id: &str, event: &str, payload: Value) {
        let _ = self.app.emit(
            CHAT_EVENT,
            json!({ "sessionId": session_id, "channel": event, "payload": payload }),
        );
    }

    fn emit_broadcast(&self, event: &str, payload: Value) {
        let _ = self.app.emit(
            CHAT_EVENT,
            json!({ "sessionId": Value::Null, "channel": event, "payload": payload }),
        );
    }
}

/// Result of a completed chat turn returned to the JS caller.
#[derive(Debug, Serialize)]
pub struct ChatResult {
    pub ok: bool,
    pub session_id: String,
    pub response_text: String,
    /// Journal turn id for this turn — used by the UI Review bar / Undo.
    pub turn_id: Option<String>,
}

/// Run one agent turn. Streams `AgentEvent`s via `codez:chat-event`.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    session_id: Option<String>,
    workspace: Option<String>,
    attachment: Option<FrontendAttachment>,
    chat_mode: Option<String>,
    model_id: Option<String>,
    clear_plan: Option<bool>,
    display_prompt: Option<String>,
    project_dir: Option<String>,
) -> Result<ChatResult, String> {
    let project = require_project_dir(
        project_dir
            .as_deref()
            .or(workspace.as_deref()),
    )?;
    let kernel = open_project_kernel_state(&app, &project)?;
    let journal = Arc::new(crate::journal::open_project_journal(&project)?);

    let sink = Arc::new(TauriEventSink { app: app.clone() });
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state.chat_cancel.lock().await;
        *slot = Some(cancel.clone());
    }

    let request = HeadlessCliRequest {
        prompt,
        workspace: Some(project.clone()),
        mode: HeadlessCliMode::Pisci,
        session_id,
        session_title: Some("CodeZ chat".to_string()),
        channel: Some(SESSION_SOURCE.to_string()),
        ..Default::default()
    };

    let result = run_codez_turn(
        request,
        kernel,
        sink,
        state.plan_state.clone(),
        cancel,
        model_id,
        chat_mode.unwrap_or_else(|| "agent".to_string()),
        attachment,
        clear_plan.unwrap_or(true),
        display_prompt,
        state.lsp_manager.clone(),
        journal.clone(),
    )
    .await;

    {
        let mut slot = state.chat_cancel.lock().await;
        *slot = None;
    }

    let response = result.map_err(|e| format!("agent turn failed: {e}"))?;
    Ok(ChatResult {
        ok: response.ok,
        session_id: response.session_id,
        response_text: response.response_text,
        turn_id: journal.current_turn_id(),
    })
}

/// Stop the in-flight chat turn, if any.
#[tauri::command]
pub async fn chat_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.chat_cancel.lock().await;
    if let Some(flag) = slot.as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}
