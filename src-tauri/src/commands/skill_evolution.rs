//! Tauri commands for skill evolution (promote, curator, revisions).

use crate::commands::curator;
use crate::commands::skill_evolution_ctx::SkillEvolutionCtx;
use crate::skills::{provenance, service};
use piscis_kernel::store::db::{SkillRevision, SkillUsage};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct SkillRevisionList {
    pub revisions: Vec<SkillRevision>,
}

#[derive(Debug, Serialize)]
pub struct SkillUsageList {
    pub usage: Vec<SkillUsage>,
}

#[derive(Debug, Serialize)]
pub struct CuratorStatus {
    pub last_run_at: Option<String>,
    pub agent_created_count: u32,
    pub draft_count: u32,
    pub learned_count: u32,
    pub archived_count: u32,
    pub top_used: Vec<SkillUsage>,
    pub least_used: Vec<SkillUsage>,
}

#[tauri::command]
pub async fn promote_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let root = ctx.skills_root();
    let db = ctx.db.lock().await;
    service::promote_draft_to_learned(&db, &root, &skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_draft_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let root = ctx.skills_root();
    let db = ctx.db.lock().await;
    service::delete_draft(&db, &root, &skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lock_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    service::set_skill_locked(&db, &skill_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unlock_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    service::set_skill_locked(&db, &skill_id, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    service::set_skill_pinned_db(&db, &skill_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    service::set_skill_pinned_db(&db, &skill_id, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_skill_revisions(
    app: AppHandle,
    skill_id: Option<String>,
    session_id: Option<String>,
    limit: Option<i64>,
) -> Result<SkillRevisionList, String> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    let revisions = if let Some(sid) = skill_id.as_deref() {
        db.list_skill_revisions_for_skill(sid, limit)
    } else if let Some(sess) = session_id.as_deref() {
        db.list_skill_revisions_for_session(sess, limit)
    } else {
        Ok(vec![])
    }
    .map_err(|e| e.to_string())?;
    Ok(SkillRevisionList { revisions })
}

#[tauri::command]
pub async fn list_skill_usage(app: AppHandle) -> Result<SkillUsageList, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let db = ctx.db.lock().await;
    let usage = db.list_skill_usage().map_err(|e| e.to_string())?;
    Ok(SkillUsageList { usage })
}

#[tauri::command]
pub async fn curator_status(app: AppHandle) -> Result<CuratorStatus, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let root = ctx.skills_root();
    let marker = root.join(".curator_last_run");
    let last_run_at = std::fs::read_to_string(&marker).ok();

    let mut draft_count = 0u32;
    let mut learned_count = 0u32;
    let mut archived_count = 0u32;
    for (dir, counter) in [
        (provenance::draft_dir(&root), &mut draft_count),
        (provenance::learned_dir(&root), &mut learned_count),
        (provenance::archive_dir(&root), &mut archived_count),
    ] {
        if dir.exists() {
            *counter = std::fs::read_dir(&dir)
                .map(|entries| entries.flatten().count() as u32)
                .unwrap_or(0);
        }
    }

    let db = ctx.db.lock().await;
    let usage = db.list_skill_usage().unwrap_or_default();
    let agent_created_count = usage
        .iter()
        .filter(|u| {
            u.created_by.as_deref() == Some("agent")
                || u.created_by.as_deref() == Some("background_review")
        })
        .count() as u32;
    let top_used: Vec<_> = usage.iter().take(5).cloned().collect();
    let least_used: Vec<_> = usage.iter().rev().take(5).cloned().collect();

    Ok(CuratorStatus {
        last_run_at,
        agent_created_count,
        draft_count,
        learned_count,
        archived_count,
        top_used,
        least_used,
    })
}

#[tauri::command]
pub async fn curator_run(app: AppHandle, dry_run: Option<bool>) -> Result<String, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    curator::run_curator_pass(&app, &ctx, dry_run.unwrap_or(false)).await
}

#[tauri::command]
pub async fn curator_rollback(app: AppHandle) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    curator::rollback_latest_backup(&ctx).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_archived_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let root = ctx.skills_root();
    let db = ctx.db.lock().await;
    service::restore_archived(&db, &root, &skill_id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEvolutionSettingsDto {
    pub review_enabled: bool,
    pub review_every_turn: bool,
    pub create_skill_min_tool_calls: u32,
    pub umbrella_skill_interval_turns: u32,
    pub curator_interval_hours: u32,
    pub curator_min_idle_hours: u32,
    pub stale_after_days: u32,
    pub archive_after_days: u32,
    pub curator_llm_merge_enabled: bool,
}

#[tauri::command]
pub async fn get_skill_evolution_settings(
    app: AppHandle,
) -> Result<SkillEvolutionSettingsDto, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let s = ctx.settings.lock().await;
    let e = &s.skill_evolution;
    Ok(SkillEvolutionSettingsDto {
        review_enabled: e.review_enabled,
        review_every_turn: e.review_every_turn,
        create_skill_min_tool_calls: e.create_skill_min_tool_calls,
        umbrella_skill_interval_turns: e.umbrella_skill_interval_turns,
        curator_interval_hours: e.curator_interval_hours,
        curator_min_idle_hours: e.curator_min_idle_hours,
        stale_after_days: e.stale_after_days,
        archive_after_days: e.archive_after_days,
        curator_llm_merge_enabled: e.curator_llm_merge_enabled,
    })
}

#[tauri::command]
pub async fn save_skill_evolution_settings(
    app: AppHandle,
    updates: SkillEvolutionSettingsDto,
) -> Result<SkillEvolutionSettingsDto, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    {
        let mut s = ctx.settings.lock().await;
        s.skill_evolution.review_enabled = updates.review_enabled;
        s.skill_evolution.review_every_turn = updates.review_every_turn;
        s.skill_evolution.create_skill_min_tool_calls = updates.create_skill_min_tool_calls.max(1);
        s.skill_evolution.umbrella_skill_interval_turns =
            updates.umbrella_skill_interval_turns.max(1);
        s.skill_evolution.curator_interval_hours = updates.curator_interval_hours.max(1);
        s.skill_evolution.curator_min_idle_hours = updates.curator_min_idle_hours;
        s.skill_evolution.stale_after_days = updates.stale_after_days.max(1);
        s.skill_evolution.archive_after_days = updates.archive_after_days.max(1);
        s.skill_evolution.curator_llm_merge_enabled = updates.curator_llm_merge_enabled;
        s.save().map_err(|e| e.to_string())?;
    }
    get_skill_evolution_settings(app).await
}
