//! Tauri commands for the file journal — Review / Undo of a turn's edits.

use tauri::AppHandle;

use crate::commands::data_scope::require_project_dir;
use crate::journal::{open_project_journal, JournalChange, JournalFileDiff};

/// List the files changed by a turn (applied, not yet undone), newest first.
#[tauri::command]
pub async fn journal_list_changes(
    _app: AppHandle,
    project_dir: Option<String>,
    session_id: String,
    turn_id: String,
) -> Result<Vec<JournalChange>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let journal = open_project_journal(&project)?;
    journal
        .list_changes(&session_id, &turn_id)
        .map_err(|e| e.to_string())
}

/// Before/after contents for inline diff cards in the CodeZ stream.
#[tauri::command]
pub async fn journal_get_turn_diffs(
    _app: AppHandle,
    project_dir: Option<String>,
    session_id: String,
    turn_id: String,
) -> Result<Vec<JournalFileDiff>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let journal = open_project_journal(&project)?;
    journal
        .get_turn_file_diffs(&session_id, &turn_id)
        .map_err(|e| e.to_string())
}

/// Undo every applied change in a turn, restoring pre-edit file content.
/// Returns the restored relative paths.
#[tauri::command]
pub async fn journal_undo_turn(
    _app: AppHandle,
    project_dir: Option<String>,
    session_id: String,
    turn_id: String,
) -> Result<Vec<String>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let journal = open_project_journal(&project)?;
    journal
        .undo_turn(&session_id, &turn_id)
        .map_err(|e| e.to_string())
}
