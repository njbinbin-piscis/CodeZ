//! Pool (team collaboration) read + lifecycle commands (Phase 3).
//!
//! The kernel owns Pool orchestration; these commands expose the project DB's
//! `pool_sessions` / `pool_messages` / `koi_todos` / `kois` rows to the
//! collaboration board UI, plus light lifecycle controls (pause/resume/archive/
//! delete). Dispatch itself happens through the main agent's `pool_org` /
//! `pool_chat` tools, so there is no per-task dispatch command here.

use serde::Serialize;
use tauri::AppHandle;

use piscis_core::models::{KoiDefinition, KoiTodo, PoolMessage, PoolSession};

use crate::commands::data_scope::open_project_kernel_state;

#[derive(Debug, Serialize)]
pub struct PoolMember {
    pub koi_id: String,
    pub name: String,
    pub role: String,
    pub icon: String,
    pub color: String,
    pub status: String,
}

#[tauri::command]
pub async fn pool_list(app: AppHandle, project_dir: String) -> Result<Vec<PoolSession>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.list_pool_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_get(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
) -> Result<Option<PoolSession>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.get_pool_session(&pool_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_members(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
) -> Result<Vec<PoolMember>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    let ids = db.list_pool_member_ids(&pool_id).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for koi_id in ids {
        if let Ok(Some(k)) = db.get_koi(&koi_id) {
            out.push(PoolMember {
                koi_id: k.id,
                name: k.name,
                role: k.role,
                icon: k.icon,
                color: k.color,
                status: k.status,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn pool_messages(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PoolMessage>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.get_pool_messages(&pool_id, limit.unwrap_or(200), offset.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_todos(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
) -> Result<Vec<KoiTodo>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.list_active_todos_by_pool(&pool_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_kois(app: AppHandle, project_dir: String) -> Result<Vec<KoiDefinition>, String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.list_kois().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_set_status(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
    status: String,
) -> Result<(), String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.update_pool_session_status(&pool_id, &status)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pool_delete(
    app: AppHandle,
    project_dir: String,
    pool_id: String,
) -> Result<(), String> {
    let (db, _s) = open_project_kernel_state(&app, &project_dir)?;
    let db = db.lock().await;
    db.delete_pool_session(&pool_id).map_err(|e| e.to_string())
}
