//! Background pool patrol for swarm teams.
//!
//! Swarm runs in AgentZ are driven by the main agent turn dispatching member
//! Koi through `pool_org(assign_koi)`; there is no always-on coordinator
//! process. If a Koi turn crashes, times out, or a todo is left pending while
//! its owner is idle, nothing would re-drive it. This patrol mirrors the kernel
//! recovery loop wired by `openpiscis` bootstrap: per project DB it periodically
//!
//! 1. rolls back stale `busy` Koi and `in_progress` todos (watchdog), and
//! 2. re-activates pending todos for each active pool whose owner is idle.
//!
//! Because AgentZ uses per-project DBs (no single global store), patrols are
//! keyed by `project_dir` and deduplicated. A patrol auto-exits once its project
//! has no non-archived pools left, so idle projects cost nothing.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;
use tracing::{info, warn};

use piscis_kernel::pool::coordinator::{self, CoordinatorConfig};
use piscis_kernel::pool::store::PoolStore;

use crate::commands::data_scope::open_project_kernel_state;
use crate::runtime::koi::pool_wiring;

/// How long a `busy` Koi / `in_progress` todo may go without progress before
/// the watchdog rolls it back (steady-state rounds only; startup uses 0).
const STALE_BUSY_SECS: i64 = 600;
/// Interval between patrol rounds for an active project.
const PATROL_INTERVAL: Duration = Duration::from_secs(30);
/// Consecutive empty rounds (no non-archived pools) before a patrol retires.
const EMPTY_ROUNDS_BEFORE_EXIT: u32 = 3;

fn registry() -> &'static Mutex<HashSet<String>> {
    static REG: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Lock the dedup registry, tolerating a poisoned mutex: a patrol round that
/// panicked while holding the lock must not permanently wedge all future
/// patrols, so we recover the inner set instead of unwrapping.
fn lock_registry() -> std::sync::MutexGuard<'static, HashSet<String>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

/// Ensure a background patrol is running for `project_dir`. Idempotent: a second
/// call while a patrol is already active for the same project is a no-op.
pub fn ensure_pool_patrol(app: &AppHandle, project_dir: &str) {
    let dir = project_dir.trim().to_string();
    if dir.is_empty() {
        return;
    }
    {
        let mut reg = lock_registry();
        if !reg.insert(dir.clone()) {
            return;
        }
    }
    let app = app.clone();
    tokio::spawn(async move {
        run_patrol(app, dir.clone()).await;
        lock_registry().remove(&dir);
    });
}

async fn run_patrol(app: AppHandle, project_dir: String) {
    info!(target: "pool::patrol", project_dir = %project_dir, "swarm patrol started");
    // Startup sweep recovers anything left stale by a previous crash immediately.
    run_round_isolated(&app, &project_dir, 0).await;

    let mut empty_rounds = 0u32;
    loop {
        tokio::time::sleep(PATROL_INTERVAL).await;
        match run_round_isolated(&app, &project_dir, STALE_BUSY_SECS).await {
            Some(0) => {
                empty_rounds += 1;
                if empty_rounds >= EMPTY_ROUNDS_BEFORE_EXIT {
                    info!(target: "pool::patrol", project_dir = %project_dir, "swarm patrol retiring (no active pools)");
                    return;
                }
            }
            Some(_) => empty_rounds = 0,
            None => {
                // DB could not be opened (project removed?) — retire.
                return;
            }
        }
    }
}

/// Run one round inside its own task so a panic in DB/runtime code is contained
/// to that round (logged + treated as a non-empty round) rather than killing
/// the whole patrol loop.
async fn run_round_isolated(app: &AppHandle, project_dir: &str, max_busy_secs: i64) -> Option<u32> {
    let app = app.clone();
    let dir = project_dir.to_string();
    match tokio::spawn(async move { run_round(&app, &dir, max_busy_secs).await }).await {
        Ok(outcome) => outcome,
        Err(join_err) => {
            warn!(
                target: "pool::patrol",
                project_dir = %project_dir,
                "patrol round panicked, continuing: {join_err}"
            );
            // Treat a panicked round as "work present" so the patrol keeps going
            // instead of prematurely retiring.
            Some(1)
        }
    }
}

/// One patrol round. Returns the number of non-archived pools observed, or
/// `None` if the project DB could not be opened.
async fn run_round(app: &AppHandle, project_dir: &str, max_busy_secs: i64) -> Option<u32> {
    let (db, _settings) = open_project_kernel_state(app, project_dir).ok()?;
    let store = PoolStore::new(db.clone());

    let pools = {
        let guard = db.lock().await;
        guard
            .list_pool_sessions()
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.status != "archived")
            .collect::<Vec<_>>()
    };
    let active_pools = pools.iter().filter(|p| p.status == "active").count() as u32;
    if pools.is_empty() {
        return Some(0);
    }

    let effective_max_busy = if max_busy_secs <= 0 {
        0
    } else {
        pools
            .iter()
            .filter(|p| p.status == "active")
            .map(|p| {
                if p.task_timeout_secs > 0 {
                    ((p.task_timeout_secs as i64 * 12) / 10).max(STALE_BUSY_SECS)
                } else {
                    STALE_BUSY_SECS
                }
            })
            .max()
            .unwrap_or(STALE_BUSY_SECS)
    };

    if effective_max_busy > 0 {
        let (stale_koi, stale_todo) =
            coordinator::watchdog_recover(&store, effective_max_busy).await;
        if stale_koi > 0 || stale_todo > 0 {
            info!(
                target: "pool::patrol",
                project_dir = %project_dir,
                max_busy = effective_max_busy,
                "recovered {stale_koi} stale Koi, {stale_todo} stale todos"
            );
        }
    }

    let (subagent, sink) = pool_wiring(app);
    let cfg = CoordinatorConfig::default();
    for pool in pools.iter().filter(|p| p.status == "active") {
        match coordinator::activate_pending_todos(
            &store,
            sink.clone(),
            subagent.clone(),
            &cfg,
            Some(&pool.id),
        )
        .await
        {
            Ok(n) if n > 0 => {
                info!(target: "pool::patrol", pool_id = %pool.id, "activated {n} pending todos")
            }
            Err(e) => {
                warn!(target: "pool::patrol", pool_id = %pool.id, "activation error: {e}")
            }
            _ => {}
        }
    }
    Some(active_pools)
}
