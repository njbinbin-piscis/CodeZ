//! Chat session management — list / load / fork / delete / checkpoints.

use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;

use piscis_kernel::store::db::{ChatMessage, Database};

use crate::commands::data_scope::{open_project_kernel_state, ProjectDirParam, SESSION_SOURCE};

/// Lightweight session row for the UI sidebar.
#[derive(Debug, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: Option<String>,
    pub status: String,
    pub message_count: i64,
    pub updated_at: String,
}

/// A single persisted chat message for history reload.
#[derive(Debug, Serialize)]
pub struct MessageDto {
    pub id: String,
    pub role: String,
    pub content: String,
}

/// Open the project-local session DB.
async fn with_db<T>(
    app: &AppHandle,
    project: ProjectDirParam,
    f: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    let project_dir = project.required()?;
    let (db, _settings) = open_project_kernel_state(app, &project_dir)?;
    let guard = db.lock().await;
    f(&guard)
}

fn messages_raw_chronological(db: &Database, session_id: &str) -> Result<Vec<ChatMessage>, String> {
    db.get_messages_latest(session_id, 1000)
        .map_err(|e| format!("get_messages failed: {e}"))
}

/// UI-facing history: drop empty tool-result user rows and merge consecutive
/// assistant chunks from the same agent turn into one bubble.
fn messages_for_ui(msgs: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    for m in msgs {
        if m.role != "user" && m.role != "assistant" {
            continue;
        }
        if m.content.trim().is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if last.role == "assistant" && m.role == "assistant" {
                last.content.push_str("\n\n");
                last.content.push_str(&m.content);
                // Anchor checkpoint/fork to the last chunk in the merged turn.
                last.id = m.id;
                continue;
            }
        }
        out.push(m);
    }
    out
}

fn messages_chronological(db: &Database, session_id: &str) -> Result<Vec<ChatMessage>, String> {
    Ok(messages_for_ui(messages_raw_chronological(db, session_id)?))
}

fn copy_messages_to_session(
    db: &Database,
    source_id: &str,
    dest_id: &str,
    up_to_message_id: Option<&str>,
) -> Result<(), String> {
    let msgs = messages_raw_chronological(db, source_id)?;
    if msgs.is_empty() {
        return Ok(());
    }
    if let Some(target) = up_to_message_id {
        let mut found = false;
        for m in msgs {
            db.append_message(dest_id, &m.role, &m.content)
                .map_err(|e| format!("copy message failed: {e}"))?;
            if m.id == target {
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!(
                "checkpoint message '{target}' not found in session"
            ));
        }
    } else {
        for m in msgs {
            db.append_message(dest_id, &m.role, &m.content)
                .map_err(|e| format!("copy message failed: {e}"))?;
        }
    }
    Ok(())
}

/// List recent chat sessions, newest first.
#[tauri::command]
pub async fn chat_list_sessions(
    app: AppHandle,
    project_dir: Option<String>,
) -> Result<Vec<SessionMeta>, String> {
    with_db(&app, ProjectDirParam { project_dir }, |db| {
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

/// Load a session's messages in chronological order.
#[tauri::command]
pub async fn chat_get_messages(
    app: AppHandle,
    session_id: String,
    project_dir: Option<String>,
) -> Result<Vec<MessageDto>, String> {
    with_db(&app, ProjectDirParam { project_dir }, |db| {
        Ok(messages_chronological(db, &session_id)?
            .into_iter()
            .map(|m| MessageDto {
                id: m.id,
                role: m.role,
                content: m.content,
            })
            .collect())
    })
    .await
}

/// Fork a session — optionally copy only up to a checkpoint message (inclusive).
#[tauri::command]
pub async fn chat_fork_session(
    app: AppHandle,
    session_id: String,
    title: Option<String>,
    up_to_message_id: Option<String>,
    project_dir: Option<String>,
) -> Result<SessionMeta, String> {
    with_db(&app, ProjectDirParam { project_dir }, |db| {
        let source = db
            .get_session(&session_id)
            .map_err(|e| format!("get_session failed: {e}"))?
            .ok_or_else(|| format!("session '{session_id}' not found"))?;

        let fork_title = title.unwrap_or_else(|| {
            let base = source.title.unwrap_or_else(|| "Chat".to_string());
            if up_to_message_id.is_some() {
                format!("{base} (fork @ checkpoint)")
            } else {
                format!("{base} (fork)")
            }
        });
        let created = db
            .create_session_with_source(Some(&fork_title), SESSION_SOURCE)
            .map_err(|e| format!("create_session failed: {e}"))?;

        copy_messages_to_session(db, &session_id, &created.id, up_to_message_id.as_deref())?;

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

/// Restore session to a checkpoint — deletes all messages after the given
/// message. When `restore_files` is true, also rolls back the file edits made
/// by the most recent agent turn that touched the workspace (best-effort), so
/// restoring a checkpoint reverts both the conversation *and* the changes the
/// agent applied afterwards.
#[tauri::command]
pub async fn chat_restore_checkpoint(
    app: AppHandle,
    session_id: String,
    message_id: String,
    project_dir: Option<String>,
    restore_files: Option<bool>,
) -> Result<Vec<String>, String> {
    let project = ProjectDirParam {
        project_dir: project_dir.clone(),
    }
    .required()?;

    with_db(&app, ProjectDirParam { project_dir }, |db| {
        let rowid: i64 = db
            .conn
            .query_row(
                "SELECT rowid FROM messages WHERE id = ?1 AND session_id = ?2",
                params![message_id, session_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("checkpoint message not found: {e}"))?;

        db.conn
            .execute(
                "DELETE FROM messages WHERE session_id = ?1 AND rowid > ?2",
                params![session_id, rowid],
            )
            .map_err(|e| format!("delete messages failed: {e}"))?;

        db.recompute_session_message_count(&session_id)
            .map_err(|e| format!("recompute message count failed: {e}"))?;
        Ok(())
    })
    .await?;

    if !restore_files.unwrap_or(false) {
        return Ok(Vec::new());
    }

    // Roll back the latest turn's file edits via the project journal.
    let journal = crate::journal::open_project_journal(&project)?;
    match journal
        .latest_turn_with_changes(&session_id)
        .map_err(|e| e.to_string())?
    {
        Some(turn_id) => journal
            .undo_turn(&session_id, &turn_id)
            .map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Delete a session and its messages.
#[tauri::command]
pub async fn chat_delete_session(
    app: AppHandle,
    session_id: String,
    project_dir: Option<String>,
) -> Result<(), String> {
    with_db(&app, ProjectDirParam { project_dir }, |db| {
        db.delete_session(&session_id)
            .map_err(|e| format!("delete_session failed: {e}"))
    })
    .await
}
