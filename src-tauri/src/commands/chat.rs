//! AI chat command — drives a single agent turn on the shared `piscis-engine`
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
    workspace_dir: Option<String>,
    task_key: Option<String>,
) -> Result<ChatResult, String> {
    let project = require_project_dir(
        project_dir
            .as_deref()
            .or(workspace.as_deref()),
    )?;
    // When an isolated worktree is provided, the agent works inside it (and the
    // journal tracks its files) while sessions stay in the main project's DB.
    let agent_workspace = workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(|d| d.to_string())
        .unwrap_or_else(|| project.clone());
    let kernel = open_project_kernel_state(&app, &project)?;
    let journal = Arc::new(crate::journal::open_project_journal(&agent_workspace)?);
    let config_dir = resolve_config_dir(&app)?;

    // Queue behind the concurrency limit. For single (IDE) chats this is a
    // no-op; for a burst of parallel Agent tasks it bounds resource use.
    let _permit = state
        .agent_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("agent scheduler closed: {e}"))?;

    let sink = Arc::new(TauriEventSink { app: app.clone() });
    let cancel = Arc::new(AtomicBool::new(false));
    // Parallel Agent tasks register their cancel flag under a unique task key
    // so Stop targets just that task; the legacy single slot stays for the
    // sequential IDE chat panel.
    let task_key = task_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|k| k.to_string());
    match &task_key {
        Some(key) => {
            state
                .task_cancel
                .lock()
                .await
                .insert(key.clone(), cancel.clone());
        }
        None => {
            let mut slot = state.chat_cancel.lock().await;
            *slot = Some(cancel.clone());
        }
    }

    let request = HeadlessCliRequest {
        prompt,
        workspace: Some(agent_workspace.clone()),
        mode: HeadlessCliMode::Pisci,
        session_id,
        session_title: Some("CodeZ chat".to_string()),
        channel: Some(SESSION_SOURCE.to_string()),
        ..Default::default()
    };

    let result = run_codez_turn(
        app.clone(),
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
        config_dir,
    )
    .await;

    match &task_key {
        Some(key) => {
            state.task_cancel.lock().await.remove(key);
        }
        None => {
            let mut slot = state.chat_cancel.lock().await;
            *slot = None;
        }
    }

    let response = result.map_err(|e| format!("agent turn failed: {e}"))?;
    Ok(ChatResult {
        ok: response.ok,
        session_id: response.session_id,
        response_text: response.response_text,
        turn_id: journal.current_turn_id(),
    })
}

/// Stop an in-flight chat turn. With `task_key` it stops just that parallel
/// Agent task; without one it stops the sequential IDE chat turn.
#[tauri::command]
pub async fn chat_cancel(
    state: State<'_, AppState>,
    task_key: Option<String>,
) -> Result<(), String> {
    match task_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        Some(key) => {
            if let Some(flag) = state.task_cancel.lock().await.get(key) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        None => {
            let slot = state.chat_cancel.lock().await;
            if let Some(flag) = slot.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    Ok(())
}
