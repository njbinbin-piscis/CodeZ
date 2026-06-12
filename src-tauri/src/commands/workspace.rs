//! Workspace session persistence — hot-exit style restore (VS Code / Cursor).
//!
//! Snapshot is stored at `{config_dir}/workspace-state.json` and includes the
//! last project folder, UI layout, and editor tabs (with unsaved buffers).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::data_scope::resolve_global_config_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditorSnapshot {
    #[serde(default)]
    pub open_paths: Vec<String>,
    #[serde(default)]
    pub active_path: Option<String>,
    /// Relative path → unsaved editor buffer (only for dirty tabs).
    #[serde(default)]
    pub dirty_buffers: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LayoutSnapshot {
    #[serde(default = "default_true")]
    pub chat_open: bool,
    #[serde(default = "default_chat_width")]
    pub chat_width: u32,
    #[serde(default)]
    pub browser_open: bool,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_sidebar_tab")]
    pub sidebar_tab: String,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default)]
    pub bottom_open: bool,
    #[serde(default = "default_bottom_tab")]
    pub bottom_tab: String,
    #[serde(default = "default_bottom_height")]
    pub bottom_height: u32,
    #[serde(default)]
    pub explorer_expanded_paths: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_chat_width() -> u32 {
    380
}
fn default_mode() -> String {
    "codez".into()
}
fn default_sidebar_tab() -> String {
    "explorer".into()
}
fn default_sidebar_width() -> u32 {
    260
}
fn default_bottom_tab() -> String {
    "terminal".into()
}
fn default_bottom_height() -> u32 {
    240
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    #[serde(default = "default_version")]
    pub version: u32,
    pub project_dir: Option<String>,
    #[serde(default)]
    pub editor: EditorSnapshot,
    #[serde(default)]
    pub layout: LayoutSnapshot,
}

fn default_version() -> u32 {
    1
}

fn workspace_state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("workspace-state.json")
}

fn sanitize_snapshot(mut snap: WorkspaceSnapshot) -> WorkspaceSnapshot {
    if let Some(ref dir) = snap.project_dir {
        let trimmed = dir.trim();
        if trimmed.is_empty() || !Path::new(trimmed).is_dir() {
            snap.project_dir = None;
        } else {
            snap.project_dir = Some(trimmed.to_string());
        }
    }
    snap.editor
        .open_paths
        .retain(|p| !p.starts_with("diff:") && p != "__agentz_browser__" && !p.trim().is_empty());
    snap.editor.dirty_buffers.retain(|path, content| {
        !path.starts_with("diff:")
            && path != "__agentz_browser__"
            && !content.is_empty()
            && snap.editor.open_paths.iter().any(|p| p == path)
    });
    if let Some(ref active) = snap.editor.active_path {
        if !snap.editor.open_paths.iter().any(|p| p == active) {
            snap.editor.active_path = snap.editor.open_paths.first().cloned();
        }
    }
    snap
}

/// Shared flag: set when the frontend has acked close so we allow destroy.
#[derive(Clone)]
pub struct WorkspaceCloseGate(pub Arc<AtomicBool>);

impl Default for WorkspaceCloseGate {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

impl WorkspaceCloseGate {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub async fn workspace_load(app: AppHandle) -> Result<Option<WorkspaceSnapshot>, String> {
    let dir = resolve_global_config_dir(&app)?;
    let path = workspace_state_path(&dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let snap: WorkspaceSnapshot = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(sanitize_snapshot(snap)))
}

#[tauri::command]
pub async fn workspace_save(app: AppHandle, snapshot: WorkspaceSnapshot) -> Result<(), String> {
    let dir = resolve_global_config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let snap = sanitize_snapshot(snapshot);
    let text = serde_json::to_string_pretty(&snap).map_err(|e| e.to_string())?;
    std::fs::write(workspace_state_path(&dir), text).map_err(|e| e.to_string())?;
    Ok(())
}

/// Called by the frontend after it has persisted workspace state on close.
#[tauri::command]
pub async fn workspace_close_ack(
    window: WebviewWindow,
    gate: State<'_, WorkspaceCloseGate>,
) -> Result<(), String> {
    gate.0.store(true, Ordering::SeqCst);
    window.destroy().map_err(|e| e.to_string())?;
    Ok(())
}

/// Install window close handler — emits `app-before-close` so the UI can save.
pub fn install_close_handler(app: &AppHandle, gate: WorkspaceCloseGate) {
    let handle = app.clone();
    let gate_flag = gate.0.clone();
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if gate_flag.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                gate_flag.store(false, Ordering::SeqCst);
                let _ = handle.emit("app-before-close", ());
            }
        });
    }
}
