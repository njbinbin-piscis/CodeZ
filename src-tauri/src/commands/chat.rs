//! AI chat command — drives a single agent turn on the shared `pisci-engine`
//! kernel and streams [`AgentEvent`]s back to the frontend.
//!
//! This is the M1 seam between CodeZ's UI and the kernel. It reuses the
//! host-agnostic [`pisci_kernel::headless::run_pisci_turn`] runner (the same
//! entry point `openpisci-headless` uses), so the editor copilot and the CLI
//! share identical single-agent semantics. The only host-specific piece is the
//! [`EventSink`] below, which re-emits every kernel event as a Tauri event.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use pisci_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest};
use pisci_kernel::agent::tool::{new_tool_registry_handle, ToolRegistryHandleExt};
use pisci_kernel::headless::{self, register_default_cli_tools, HeadlessDeps};

/// Tauri event channel that carries every streamed kernel event to the UI.
pub const CHAT_EVENT: &str = "codez:chat-event";

/// Bridges the kernel's [`EventSink`] to Tauri events. Each kernel
/// `emit_session` / `emit_broadcast` becomes a `codez:chat-event` payload the
/// chat sidebar listens for.
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

/// Result of a completed chat turn returned to the JS caller. Streaming text
/// arrives via `codez:chat-event`; this is the tidy final summary.
#[derive(Debug, Serialize)]
pub struct ChatResult {
    pub ok: bool,
    pub session_id: String,
    pub response_text: String,
}

/// Resolve the directory that holds `config.json` + `pisci.db`.
///
/// `CODEZ_CONFIG_DIR` wins (handy for tests / sharing an existing openpisci
/// config); otherwise the platform app-data dir for `com.codez.desktop`.
pub(crate) fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CODEZ_CONFIG_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

/// Run one agent turn. Streams `AgentEvent`s via `codez:chat-event` and
/// resolves with the final assistant text once the loop reports `Done`.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    prompt: String,
    session_id: Option<String>,
    workspace: Option<String>,
) -> Result<ChatResult, String> {
    let config_dir = resolve_config_dir(&app)?;
    let (db, settings) = headless::open_kernel_state(&config_dir)
        .map_err(|e| format!("failed to initialise kernel state: {e}"))?;

    let mut handle = new_tool_registry_handle();
    register_default_cli_tools(&mut handle, db.clone(), settings.clone());
    let registry = handle
        .into_registry()
        .map_err(|_| "internal: tool registry handle type mismatch".to_string())?;

    let sink = Arc::new(TauriEventSink { app: app.clone() });
    let deps = HeadlessDeps::new(db, settings, registry, sink);

    let request = HeadlessCliRequest {
        prompt,
        workspace,
        mode: HeadlessCliMode::Pisci,
        session_id,
        session_title: Some("CodeZ chat".to_string()),
        channel: Some("codez".to_string()),
        ..Default::default()
    };

    let response = headless::run_pisci_turn(request, deps)
        .await
        .map_err(|e| format!("agent turn failed: {e}"))?;

    Ok(ChatResult {
        ok: response.ok,
        session_id: response.session_id,
        response_text: response.response_text,
    })
}
