//! Chat session management — list / load / fork / delete / checkpoints.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use piscis_kernel::store::db::{ChatMessage, Database, Session};

use crate::commands::data_scope::{open_project_kernel_state, ProjectDirParam};
use crate::commands::session_sources::{
    excluded_from_workz_task_list, is_codez_source, is_coordinator_boilerplate_title,
    is_generic_codez_title, is_generic_workz_title, is_workz_task_source, normalize_source,
    prompt_text_for_title, source_matches_filter, sources_compatible, workz_goal_text_for_title,
    SOURCE_LEGACY, SOURCE_WORKZ_TEAM,
};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WorkzSessionMeta {
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub pool_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StateFrameEnvelope {
    #[serde(default)]
    agentz_workz: Option<WorkzSessionMeta>,
}

pub fn load_workz_meta(db: &Database, session_id: &str) -> Result<WorkzSessionMeta, String> {
    let raw = db
        .get_session_state_frame_json(session_id)
        .map_err(|e| format!("read state_frame failed: {e}"))?;
    let Some(text) = raw.filter(|s| !s.trim().is_empty()) else {
        return Ok(WorkzSessionMeta::default());
    };
    let frame: StateFrameEnvelope =
        serde_json::from_str(&text).map_err(|e| format!("parse state_frame failed: {e}"))?;
    Ok(frame.agentz_workz.unwrap_or_default())
}

pub fn persist_workz_meta(
    db: &Database,
    session_id: &str,
    team_id: Option<&str>,
    pool_id: Option<&str>,
) -> Result<(), String> {
    let mut meta = load_workz_meta(db, session_id)?;
    if let Some(t) = team_id.filter(|s| !s.trim().is_empty()) {
        meta.team_id = Some(t.to_string());
    }
    if let Some(p) = pool_id.filter(|s| !s.trim().is_empty()) {
        meta.pool_id = Some(p.to_string());
    }
    let frame = StateFrameEnvelope {
        agentz_workz: Some(meta),
    };
    let json = serde_json::to_string(&frame).map_err(|e| format!("serialize state_frame: {e}"))?;
    db.update_session_state_frame_json(session_id, Some(&json))
        .map_err(|e| format!("write state_frame failed: {e}"))
}

/// Reject continuing a session under the wrong mode namespace (or team).
pub fn validate_session_continuation(
    db: &Database,
    session_id: &str,
    expected_source: &str,
    team_id: Option<&str>,
) -> Result<(), String> {
    let existing = db
        .get_session(session_id)
        .map_err(|e| format!("get_session failed: {e}"))?
        .ok_or_else(|| format!("session '{session_id}' not found"))?;
    if !sources_compatible(expected_source, &existing.source) {
        return Err(format!(
            "session '{session_id}' belongs to '{}' but this turn expects '{}'",
            existing.source, expected_source
        ));
    }
    if normalize_source(expected_source) == SOURCE_WORKZ_TEAM {
        let meta = load_workz_meta(db, session_id)?;
        if let Some(bound) = meta.team_id.as_deref().filter(|s| !s.is_empty()) {
            let want = team_id.filter(|s| !s.is_empty()).unwrap_or("");
            if !want.is_empty() && bound != want {
                return Err(format!(
                    "session '{session_id}' is bound to team '{bound}', not '{want}'"
                ));
            }
        }
    }
    Ok(())
}

/// Lightweight session row for the UI sidebar.
#[derive(Debug, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: Option<String>,
    pub status: String,
    pub message_count: i64,
    pub updated_at: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_id: Option<String>,
}

fn truncate_title_line(text: &str, max_chars: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return String::new();
    }
    let n = line.chars().count();
    if n <= max_chars {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(max_chars).collect::<String>())
    }
}

/// After the first user message, replace generic titles with the user's question.
pub fn maybe_autotitle_session_from_first_prompt(
    db: &Database,
    session_id: &str,
    user_text: &str,
) -> Result<(), String> {
    let session = db
        .get_session(session_id)
        .map_err(|e| format!("get_session failed: {e}"))?
        .ok_or_else(|| format!("session '{session_id}' not found"))?;
    if session.message_count > 1 {
        return Ok(());
    }

    let goal = if is_workz_task_source(&session.source) {
        if !is_generic_workz_title(session.title.as_deref()) {
            return Ok(());
        }
        workz_goal_text_for_title(user_text)
    } else if is_codez_source(&session.source) {
        if !is_generic_codez_title(session.title.as_deref()) {
            return Ok(());
        }
        prompt_text_for_title(user_text)
    } else {
        return Ok(());
    };
    let title = truncate_title_line(&goal, 80);
    if title.is_empty() {
        return Ok(());
    }
    db.rename_session(session_id, &title)
        .map_err(|e| format!("rename_session failed: {e}"))
}

/// Back-compat alias for WorkZ call sites.
pub fn maybe_autotitle_workz_session(
    db: &Database,
    session_id: &str,
    user_text: &str,
) -> Result<(), String> {
    maybe_autotitle_session_from_first_prompt(db, session_id, user_text)
}

/// User + assistant text for the first chat round (CodeZ / WorkZ task sessions).
pub fn first_chat_round_for_title(db: &Database, session_id: &str) -> Option<(String, String)> {
    let session = db.get_session(session_id).ok()??;
    if !is_codez_source(&session.source) && !is_workz_task_source(&session.source) {
        return None;
    }
    let msgs = db.get_messages_latest(session_id, 32).ok()?;
    let mut users = msgs
        .iter()
        .filter(|m| m.role == "user" && !m.content.trim().is_empty())
        .collect::<Vec<_>>();
    let assistants = msgs
        .iter()
        .filter(|m| m.role == "assistant" && !m.content.trim().is_empty())
        .collect::<Vec<_>>();
    if users.len() != 1 || assistants.is_empty() {
        return None;
    }
    let raw_user = users.remove(0).content.clone();
    let user = if is_workz_task_source(&session.source) {
        workz_goal_text_for_title(&raw_user)
    } else {
        prompt_text_for_title(&raw_user)
    };
    if user.is_empty() {
        return None;
    }
    let assistant = assistants.last()?.content.clone();
    Some((user, assistant))
}

/// Normalize a one-line title from the flash model.
pub fn sanitize_llm_session_title(raw: &str) -> String {
    let mut line = raw
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '「' || c == '」' || c == '『' || c == '』')
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if line.to_ascii_lowercase().starts_with("title:") {
        line = line[6..].trim().to_string();
    }
    truncate_title_line(&line, 48)
}

/// Sidebar title for CodeZ rows when the stored title is still generic.
fn resolve_codez_list_title(db: &Database, session: &Session) -> Option<String> {
    if !is_generic_codez_title(session.title.as_deref()) {
        return session.title.clone();
    }
    let msgs = db.get_messages(&session.id, 8, 0).ok().unwrap_or_default();
    let first_user = msgs.into_iter().find(|m| m.role == "user")?;
    let title = truncate_title_line(&prompt_text_for_title(&first_user.content), 80);
    if title.is_empty() {
        return session.title.clone();
    }
    Some(title)
}

/// Sidebar title for a WorkZ task row — never the coordinator system preamble.
fn resolve_workz_task_list_title(db: &Database, session: &Session) -> Option<String> {
    if !is_generic_workz_title(session.title.as_deref())
        && !is_coordinator_boilerplate_title(session.title.as_deref())
    {
        return session.title.clone();
    }
    let msgs = db.get_messages(&session.id, 8, 0).ok().unwrap_or_default();
    let first_user = msgs.into_iter().find(|m| m.role == "user")?;
    let goal = workz_goal_text_for_title(&first_user.content);
    let title = truncate_title_line(&goal, 80);
    if title.is_empty() {
        return session.title.clone();
    }
    Some(title)
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

/// List recent chat sessions, newest first. When `sources` is non-empty, only
/// sessions whose `source` column matches one of the tags are returned (legacy
/// `agentz` rows count as CodeZ). Koi `pool` sessions are always excluded from
/// WorkZ task lists. Optional `team_id` narrows `workz-team` rows to one team.
#[tauri::command]
pub async fn chat_list_sessions(
    app: AppHandle,
    project_dir: Option<String>,
    sources: Option<Vec<String>>,
    team_id: Option<String>,
) -> Result<Vec<SessionMeta>, String> {
    let filter: Vec<String> = sources
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let team_filter = team_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let workz_listing = !filter.is_empty() && filter.iter().any(|s| is_workz_task_source(s));
    with_db(&app, ProjectDirParam { project_dir }, move |db| {
        let sessions = db
            .list_sessions(200, 0)
            .map_err(|e| format!("list_sessions failed: {e}"))?;
        Ok(sessions
            .into_iter()
            .filter(|s| {
                if filter.is_empty() {
                    return true;
                }
                if !source_matches_filter(&s.source, &filter) {
                    return false;
                }
                if workz_listing && excluded_from_workz_task_list(&s.source) {
                    return false;
                }
                if let Some(ref want_team) = team_filter {
                    if normalize_source(&s.source) == SOURCE_WORKZ_TEAM {
                        let meta = load_workz_meta(db, &s.id).unwrap_or_default();
                        match meta.team_id.as_deref().filter(|t| !t.is_empty()) {
                            Some(bound) if bound != want_team.as_str() => return false,
                            None => {}
                            _ => {}
                        }
                    }
                }
                true
            })
            .map(|s| {
                let meta = load_workz_meta(db, &s.id).unwrap_or_default();
                let title = if is_workz_task_source(&s.source) {
                    resolve_workz_task_list_title(db, &s)
                } else if is_codez_source(&s.source) {
                    resolve_codez_list_title(db, &s)
                } else {
                    s.title.clone()
                };
                SessionMeta {
                    id: s.id,
                    title,
                    status: s.status,
                    message_count: s.message_count,
                    updated_at: s.updated_at.to_rfc3339(),
                    source: s.source,
                    team_id: meta.team_id,
                    pool_id: meta.pool_id,
                }
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
        let fork_source = if source.source == SOURCE_LEGACY {
            normalize_source(&source.source).to_string()
        } else {
            source.source.clone()
        };
        let created = db
            .create_session_with_source(Some(&fork_title), &fork_source)
            .map_err(|e| format!("create_session failed: {e}"))?;

        copy_messages_to_session(db, &session_id, &created.id, up_to_message_id.as_deref())?;

        let refreshed = db
            .get_session(&created.id)
            .map_err(|e| format!("get_session failed: {e}"))?
            .unwrap_or(created);
        let meta = load_workz_meta(db, &refreshed.id).unwrap_or_default();
        Ok(SessionMeta {
            id: refreshed.id,
            title: refreshed.title,
            status: refreshed.status,
            message_count: refreshed.message_count,
            updated_at: refreshed.updated_at.to_rfc3339(),
            source: refreshed.source,
            team_id: meta.team_id,
            pool_id: meta.pool_id,
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
