//! Chat session management — list / load / fork / delete.
//!
//! These commands operate directly on the kernel's SQLite store (the same DB
//! `chat_send` writes to), so the session sidebar in the UI stays in sync with
//! whatever turns the agent has run.

use serde::Serialize;
use tauri::AppHandle;

use pisci_kernel::headless;

use crate::commands::chat::resolve_config_dir;

/// Lightweight session row for the UI sidebar.
#[derive(Debug, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: Option<String>,
    pub status: String,
    pub message_count: i64,
    pub updated_at: String,
}

/// A single persisted chat message (text only) for history reload.
#[derive(Debug, Serialize)]
pub struct MessageDto {
    pub role: String,
    pub content: String,
}

/// Open the kernel DB handle for the current config dir.
async fn with_db<T>(
    app: &AppHandle,
    f: impl FnOnce(&pisci_kernel::store::db::Database) -> Result<T, String>,
) -> Result<T, String> {
    let dir = resolve_config_dir(app)?;
    let (db, _settings) = headless::open_kernel_state(&dir)
        .map_err(|e| format!("failed to open kernel state: {e}"))?;
    let guard = db.lock().await;
    f(&guard)
}

/// List recent chat sessions, newest first.
#[tauri::command]
pub async fn chat_list_sessions(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    with_db(&app, |db| {
        let sessions = db
            .list_sessions(200, 0)
            .map_err(|e| format!("list_sessions failed: {e}"))?;
        Ok(sessions
            .into_iter()
            .map(|s| SessionMeta {
                id: s.id,
                title: s.title,
                status: s.status,
                message_count: s.message_count,
                updated_at: s.updated_at.to_rfc3339(),
            })
            .collect())
    })
    .await
}

/// Load a session's messages in chronological order (text only).
#[tauri::command]
pub async fn chat_get_messages(app: AppHandle, session_id: String) -> Result<Vec<MessageDto>, String> {
    with_db(&app, |db| {
        let mut msgs = db
            .get_messages_latest(&session_id, 1000)
            .map_err(|e| format!("get_messages failed: {e}"))?;
        msgs.reverse(); // stored newest-first; UI wants oldest-first
        Ok(msgs
            .into_iter()
            .filter(|m| m.role == "user" || m.role == "assistant")
            .map(|m| MessageDto {
                role: m.role,
                content: m.content,
            })
            .collect())
    })
    .await
}

/// Fork a session: create a fresh session and copy its user/assistant messages.
/// Returns the new session's metadata.
#[tauri::command]
pub async fn chat_fork_session(
    app: AppHandle,
    session_id: String,
    title: Option<String>,
) -> Result<SessionMeta, String> {
    with_db(&app, |db| {
        let source = db
            .get_session(&session_id)
            .map_err(|e| format!("get_session failed: {e}"))?
            .ok_or_else(|| format!("session '{session_id}' not found"))?;

        let fork_title = title.unwrap_or_else(|| {
            let base = source.title.unwrap_or_else(|| "Chat".to_string());
            format!("{base} (fork)")
        });
        let created = db
            .create_session_with_source(Some(&fork_title), "codez")
            .map_err(|e| format!("create_session failed: {e}"))?;

        let mut msgs = db
            .get_messages_latest(&session_id, 1000)
            .map_err(|e| format!("get_messages failed: {e}"))?;
        msgs.reverse();
        for m in msgs.iter().filter(|m| m.role == "user" || m.role == "assistant") {
            db.append_message(&created.id, &m.role, &m.content)
                .map_err(|e| format!("copy message failed: {e}"))?;
        }

        let refreshed = db
            .get_session(&created.id)
            .map_err(|e| format!("get_session failed: {e}"))?
            .unwrap_or(created);
        Ok(SessionMeta {
            id: refreshed.id,
            title: refreshed.title,
            status: refreshed.status,
            message_count: refreshed.message_count,
            updated_at: refreshed.updated_at.to_rfc3339(),
        })
    })
    .await
}

/// Delete a session and its messages.
#[tauri::command]
pub async fn chat_delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    with_db(&app, |db| {
        db.delete_session(&session_id)
            .map_err(|e| format!("delete_session failed: {e}"))
    })
    .await
}
