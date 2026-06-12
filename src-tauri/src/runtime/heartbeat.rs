//! Per-project pool heartbeat — lightweight coordinator turns when swarm pools
//! need attention (open todos, blocked, needs_review).

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use piscis_core::heartbeat::{
    assessment_requires_coordination, build_heartbeat_coordination_gap_notice,
    build_pool_heartbeat_message, collect_pool_attention, is_heartbeat_ack_only,
    PoolAttention,
};
use piscis_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest};
use piscis_kernel::store::settings::default_heartbeat_prompt;

use crate::commands::chat_turn::run_agentz_turn;
use crate::commands::data_scope::{open_project_kernel_state, resolve_global_config_dir};
use crate::commands::session_sources::SOURCE_PISCIS_HEARTBEAT_POOL;
use crate::commands::system_prompt::swarm_coordinator_append;
use crate::state::AppState;

const CHAT_EVENT: &str = "agentz:chat-event";

struct HeartbeatEventSink {
    app: AppHandle,
}

impl EventSink for HeartbeatEventSink {
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

fn registry() -> &'static Mutex<HashSet<String>> {
    static REG: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Ensure a background heartbeat loop runs for `project_dir` (idempotent).
pub fn ensure_pool_heartbeat(app: &AppHandle, project_dir: &str) {
    let dir = project_dir.trim().to_string();
    if dir.is_empty() {
        return;
    }
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if !reg.insert(dir.clone()) {
            return;
        }
    }
    let app = app.clone();
    tokio::spawn(async move {
        run_heartbeat_loop(app, dir.clone()).await;
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&dir);
    });
}

async fn run_heartbeat_loop(app: AppHandle, project_dir: String) {
    info!(target: "pool::heartbeat", project_dir = %project_dir, "pool heartbeat started");
    loop {
        let interval = heartbeat_interval(&app, &project_dir).await;
        tokio::time::sleep(interval).await;
        if run_heartbeat_round(&app, &project_dir).await {
            continue;
        }
        // No swarm pools left — retire.
        info!(
            target: "pool::heartbeat",
            project_dir = %project_dir,
            "pool heartbeat retiring (no active swarm pools)"
        );
        return;
    }
}

async fn heartbeat_interval(app: &AppHandle, project_dir: &str) -> Duration {
    let Ok((_, settings)) = open_project_kernel_state(app, project_dir) else {
        return Duration::from_secs(300);
    };
    let s = settings.lock().await;
    let mins = s.heartbeat_interval_mins.max(1);
    Duration::from_secs(u64::from(mins) * 60)
}

/// Returns true while the project still has active swarm pools to watch.
async fn run_heartbeat_round(app: &AppHandle, project_dir: &str) -> bool {
    let Ok((db, settings)) = open_project_kernel_state(app, project_dir) else {
        return false;
    };
    {
        let s = settings.lock().await;
        if !s.heartbeat_enabled {
            return has_active_swarm_pools(&db).await;
        }
    }

    let (pools, all_todos, koi_ids, base_prompt) = {
        let guard = db.lock().await;
        let pools: Vec<_> = guard
            .list_pool_sessions()
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.status == "active" && p.workflow_run_id.is_none())
            .collect();
        if pools.is_empty() {
            return false;
        }
        let todos = guard.list_koi_todos(None).unwrap_or_default();
        let koi_ids: Vec<String> = guard
            .list_kois()
            .unwrap_or_default()
            .into_iter()
            .map(|k| k.id)
            .collect();
        drop(guard);
        let prompt = {
            let s = settings.lock().await;
            let raw = s.heartbeat_prompt.clone();
            if raw.trim().is_empty() {
                default_heartbeat_prompt()
            } else {
                raw
            }
        };
        (pools, todos, koi_ids, prompt)
    };

    for pool in pools {
        let messages = {
            let guard = db.lock().await;
            guard
                .get_pool_messages(&pool.id, 200, 0)
                .unwrap_or_default()
        };
        let pool_todos: Vec<_> = all_todos
            .iter()
            .filter(|t| t.pool_session_id.as_deref() == Some(pool.id.as_str()))
            .cloned()
            .collect();
        let open = pool_todos.iter().any(|t| {
            matches!(
                t.status.as_str(),
                "todo" | "in_progress" | "needs_review" | "blocked"
            )
        });
        if !open {
            continue;
        }
        let Some(attention) =
            collect_pool_attention(&pool, &messages, &pool_todos, &koi_ids, 0)
        else {
            continue;
        };
        if !assessment_requires_coordination(&attention.assessment) {
            continue;
        }
        if let Err(e) = dispatch_pool_attention(app, project_dir, &attention, &base_prompt).await
        {
            warn!(
                target: "pool::heartbeat",
                pool_id = %pool.id,
                "heartbeat dispatch failed: {e}"
            );
        }
    }

    has_active_swarm_pools(&db).await
}

async fn has_active_swarm_pools(
    db: &Arc<tokio::sync::Mutex<piscis_kernel::store::db::Database>>,
) -> bool {
    let guard = db.lock().await;
    guard
        .list_pool_sessions()
        .unwrap_or_default()
        .into_iter()
        .any(|p| p.status == "active" && p.workflow_run_id.is_none())
}

async fn latest_piscis_message_id(
    db: &Arc<tokio::sync::Mutex<piscis_kernel::store::db::Database>>,
    pool_id: &str,
) -> i64 {
    let guard = db.lock().await;
    guard
        .get_pool_messages(pool_id, 100, 0)
        .ok()
        .and_then(|msgs| msgs.iter().filter(|m| m.sender_id == "piscis").map(|m| m.id).max())
        .unwrap_or(0)
}

async fn dispatch_pool_attention(
    app: &AppHandle,
    project_dir: &str,
    attention: &PoolAttention,
    base_prompt: &str,
) -> Result<(), String> {
    let kernel = open_project_kernel_state(app, project_dir).map_err(|e| e.to_string())?;
    let (db, _settings) = kernel.clone();
    {
        let guard = db.lock().await;
        guard
            .ensure_fixed_session(
                &attention.session_id,
                &format!("Piscis · {}", attention.pool_name),
                SOURCE_PISCIS_HEARTBEAT_POOL,
            )
            .map_err(|e| e.to_string())?;
    }

    let pool_msg_before = latest_piscis_message_id(&db, &attention.pool_id).await;
    let heartbeat_message = build_pool_heartbeat_message(base_prompt, attention);
    let extra = format!(
        "{}\n\nYou are reviewing pool '{}' ({}) during a heartbeat scan.\n\
         Use pool_org with pool_id=\"{}\" for all coordination. Do not use pool_chat.\n\
         Reply HEARTBEAT_OK only after verifying org_spec convergence and taking pool_org actions.",
        swarm_coordinator_append(attention.org_spec_excerpt.as_deref(), "waves"),
        attention.pool_name,
        attention.pool_id,
        attention.pool_id
    );

    let state = app.state::<AppState>();
    let config_dir = resolve_global_config_dir(app).map_err(|e| e.to_string())?;
    let journal =
        Arc::new(crate::journal::open_project_journal(project_dir).map_err(|e| e.to_string())?);
    let sink = Arc::new(HeartbeatEventSink { app: app.clone() });
    let cancel = Arc::new(AtomicBool::new(false));

    let request = HeadlessCliRequest {
        prompt: heartbeat_message,
        workspace: Some(project_dir.to_string()),
        mode: HeadlessCliMode::Piscis,
        session_id: Some(attention.session_id.clone()),
        session_title: Some(format!("Piscis · {}", attention.pool_name)),
        channel: Some(SOURCE_PISCIS_HEARTBEAT_POOL.to_string()),
        pool_id: Some(attention.pool_id.clone()),
        extra_system_context: Some(extra),
        ..Default::default()
    };

    let response = run_agentz_turn(
        app.clone(),
        request,
        kernel,
        sink,
        state.plan_state.clone(),
        cancel,
        None,
        "agent".to_string(),
        None,
        true,
        None,
        state.lsp_manager.clone(),
        state.browser.clone(),
        journal,
        config_dir,
        Vec::new(),
        None,
        None,
        None,
        Some(attention.pool_id.clone()),
    )
    .await
    .map_err(|e| e.to_string())?;

    let pool_msg_after = latest_piscis_message_id(&db, &attention.pool_id).await;
    let coordinated = pool_msg_after > pool_msg_before;
    if !coordinated
        && (assessment_requires_coordination(&attention.assessment)
            || is_heartbeat_ack_only(&response.response_text))
    {
        let notice = build_heartbeat_coordination_gap_notice(attention);
        let pool_id = attention.pool_id.clone();
        let _ = db.lock().await.insert_pool_message_ext(
            &pool_id,
            "piscis",
            &notice,
            "system",
            "{}",
            None,
            None,
            Some("heartbeat_gap"),
        );
    }

    Ok(())
}
