//! Desktop in-process Koi runtime.
//!
//! Implements the kernel [`SubagentRuntime`] contract by running each Koi turn
//! inside the running Tauri process. The pool coordinator calls
//! [`spawn_koi_turn`](SubagentRuntime::spawn_koi_turn) with a fully assembled
//! system prompt; we run it through the shared kernel headless turn
//! ([`run_piscis_turn_cancellable`]) against the Koi's project DB and stream
//! its agent events to the UI over the same `agentz:chat-event` channel the IDE
//! chat uses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use piscis_core::host::{
    EventSink, HeadlessCliMode, HeadlessCliRequest, KoiTurnExit, KoiTurnHandle, KoiTurnOutcome,
    KoiTurnRequest, PoolEvent, PoolEventSink, SubagentRuntime,
};
use piscis_core::koi_prompt::build_koi_task_system_prompt;
use piscis_kernel::agent::tool::ToolRegistry;
use piscis_kernel::headless::{run_piscis_turn_cancellable, HeadlessDeps};
use piscis_kernel::store::settings::Settings;
use piscis_kernel::tools::{register_mcp_tools, register_neutral_into, NeutralToolsConfig};

use crate::commands::chat_turn::{
    materialize_headless_llm_settings, resolve_koi_llm_provider_for_turn,
};
use crate::commands::data_scope::{open_project_kernel_state, resolve_global_config_dir};

/// Same channel the IDE chat streams over, so a Koi turn's tokens/tools can be
/// surfaced in the UI keyed by the Koi's session id.
const POOL_CHAT_EVENT: &str = "agentz:chat-event";

/// Canonical channel every kernel [`PoolEvent`] is fanned out on. The frontend
/// collaboration board subscribes once and dispatches on the serialized
/// `kind` tag.
pub const POOL_EVENT_CHANNEL: &str = "agentz:pool-event";

/// Forwards kernel pool events (todo board, koi status, coordinator lifecycle)
/// to the UI as a single typed stream.
pub struct TauriPoolEventSink {
    app: AppHandle,
}

impl TauriPoolEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl PoolEventSink for TauriPoolEventSink {
    fn emit_pool(&self, event: &PoolEvent) {
        let payload = serde_json::to_value(event).unwrap_or(Value::Null);
        let _ = self.app.emit(POOL_EVENT_CHANNEL, payload);
    }
}

/// Build the desktop pool wiring (runtime + event sink) the kernel coordinator
/// needs to fan team work out to member Koi from the main agent turn.
pub fn pool_wiring(app: &AppHandle) -> (Arc<dyn SubagentRuntime>, Arc<dyn PoolEventSink>) {
    (
        Arc::new(DesktopInProcessSubagentRuntime::new(app.clone())),
        Arc::new(TauriPoolEventSink::new(app.clone())),
    )
}

struct PoolTurnEventSink {
    app: AppHandle,
}

impl EventSink for PoolTurnEventSink {
    fn emit_session(&self, session_id: &str, event: &str, payload: Value) {
        let _ = self.app.emit(
            POOL_CHAT_EVENT,
            json!({ "sessionId": session_id, "channel": event, "payload": payload }),
        );
    }

    fn emit_broadcast(&self, event: &str, payload: Value) {
        let _ = self.app.emit(
            POOL_CHAT_EVENT,
            json!({ "sessionId": Value::Null, "channel": event, "payload": payload }),
        );
    }
}

#[derive(Clone)]
pub struct DesktopInProcessSubagentRuntime {
    app: AppHandle,
    inflight: Arc<Mutex<HashMap<String, Arc<InflightTurn>>>>,
}

struct InflightTurn {
    cancel: Arc<AtomicBool>,
    outcome_rx: Mutex<Option<oneshot::Receiver<anyhow::Result<KoiTurnOutcome>>>>,
}

impl DesktopInProcessSubagentRuntime {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl SubagentRuntime for DesktopInProcessSubagentRuntime {
    async fn spawn_koi_turn(&self, request: KoiTurnRequest) -> anyhow::Result<KoiTurnHandle> {
        let turn_id = Uuid::new_v4().to_string();
        let handle = KoiTurnHandle {
            turn_id: turn_id.clone(),
            pool_id: request.pool_id.clone(),
            koi_id: request.koi_id.clone(),
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let turn = Arc::new(InflightTurn {
            cancel: cancel.clone(),
            outcome_rx: Mutex::new(Some(outcome_rx)),
        });
        self.inflight.lock().await.insert(turn_id, turn);

        let app = self.app.clone();
        let inflight = self.inflight.clone();
        let cleanup_turn_id = handle.turn_id.clone();
        let handle_for_task = handle.clone();
        tokio::spawn(async move {
            let outcome = run_in_process_koi_turn(app, handle_for_task, request, cancel).await;
            let _ = outcome_tx.send(outcome);
            cleanup_unclaimed_outcome(inflight, cleanup_turn_id).await;
        });

        Ok(handle)
    }

    async fn cancel_koi_turn(&self, handle: &KoiTurnHandle) -> anyhow::Result<()> {
        let turn = {
            let inflight = self.inflight.lock().await;
            inflight.get(&handle.turn_id).cloned()
        };
        if let Some(turn) = turn {
            turn.cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    async fn wait_koi_turn(&self, handle: &KoiTurnHandle) -> anyhow::Result<KoiTurnOutcome> {
        let turn = {
            let inflight = self.inflight.lock().await;
            inflight
                .get(&handle.turn_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("unknown Koi turn: {}", handle.turn_id))?
        };
        let rx =
            turn.outcome_rx.lock().await.take().ok_or_else(|| {
                anyhow::anyhow!("wait_koi_turn called twice for {}", handle.turn_id)
            })?;
        let outcome = rx.await.unwrap_or_else(|_| {
            Ok(KoiTurnOutcome {
                handle: handle.clone(),
                exit_kind: KoiTurnExit::Crashed,
                response_text: String::new(),
                error: Some("in-process Koi task dropped before completion".into()),
                exit_code: None,
            })
        })?;
        self.inflight.lock().await.remove(&handle.turn_id);
        Ok(outcome)
    }
}

/// Reap an outcome that `wait_koi_turn` never claimed (e.g. the coordinator
/// gave up), so the inflight map does not grow unbounded.
async fn cleanup_unclaimed_outcome(
    inflight: Arc<Mutex<HashMap<String, Arc<InflightTurn>>>>,
    turn_id: String,
) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    let turn = {
        let inflight = inflight.lock().await;
        inflight.get(&turn_id).cloned()
    };
    let Some(turn) = turn else {
        return;
    };
    if turn.outcome_rx.lock().await.is_some() {
        inflight.lock().await.remove(&turn_id);
    }
}

/// Build the tool surface a Koi member gets: full neutral tools (read / write /
/// shell / code_run) plus codebase search and web fetch, plus the user's MCP
/// servers and authorized connectors. Intentionally omits `delegate` (no
/// recursive fan-out) and UI-bound tools (chat_ui / browser).
async fn build_koi_registry(
    app: &AppHandle,
    db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    settings: Arc<Mutex<Settings>>,
    event_sink: Arc<dyn EventSink>,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    let cfg = NeutralToolsConfig {
        db: Some(db),
        settings: Some(settings.clone()),
        event_sink: Some(event_sink),
        ..Default::default()
    };
    register_neutral_into(&mut registry, &cfg);
    registry.register(Box::new(crate::tools::codebase_search::CodebaseSearchTool));

    let mcp_servers = { settings.lock().await.mcp_servers.clone() };
    if !mcp_servers.is_empty() {
        register_mcp_tools(&mut registry, &mcp_servers).await;
    }
    if let Ok(config_dir) = resolve_global_config_dir(app) {
        registry.register(Box::new(crate::tools::api_connector::ApiConnectorTool {
            config_dir: config_dir.clone(),
            allowed_ids: None,
        }));
        let connector_configs =
            crate::commands::connectors::resolve_connector_mcp_configs(&config_dir);
        if !connector_configs.is_empty() {
            register_mcp_tools(&mut registry, &connector_configs).await;
        }
    }
    registry
}

async fn run_in_process_koi_turn(
    app: AppHandle,
    handle: KoiTurnHandle,
    request: KoiTurnRequest,
    cancel: Arc<AtomicBool>,
) -> anyhow::Result<KoiTurnOutcome> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(cancelled_outcome(handle, "cancelled before dispatch"));
    }

    // Resolve the project directory: coordinator-provided workspace first.
    // Pool turns must carry the pool's project_dir (or worktree); never
    // fall back to the global settings workspace_root for those.
    let project_dir = match request.workspace.clone().filter(|w| !w.trim().is_empty()) {
        Some(w) => w,
        None if !request.pool_id.trim().is_empty() => {
            return Ok(crashed_outcome(
                handle,
                "pool Koi turn missing workspace (pool project_dir was not passed)",
            ));
        }
        None => resolve_global_config_dir(&app)
            .ok()
            .and_then(|dir| Settings::load(&dir.join("config.json")).ok())
            .map(|s| s.workspace_root)
            .filter(|w| !w.trim().is_empty())
            .unwrap_or_default(),
    };
    if project_dir.trim().is_empty() {
        return Ok(crashed_outcome(
            handle,
            "no workspace configured for Koi turn",
        ));
    }

    let (db, settings) = match open_project_kernel_state(&app, &project_dir) {
        Ok(state) => state,
        Err(e) => return Ok(crashed_outcome(handle, &e)),
    };

    // Headless turns only read legacy `settings.provider/model`; map the Koi's
    // bound provider (or flash / first llm_providers entry) before dispatch.
    let koi_llm_provider_id = {
        let guard = db.lock().await;
        resolve_global_config_dir(&app)
            .ok()
            .and_then(|dir| resolve_koi_llm_provider_for_turn(&guard, &dir, &request.koi_id))
            .or_else(|| {
                guard
                    .get_koi(&request.koi_id)
                    .ok()
                    .flatten()
                    .and_then(|k| k.llm_provider_id)
            })
    };
    {
        let mut s = settings.lock().await;
        materialize_headless_llm_settings(&mut s, &app, koi_llm_provider_id.as_deref());
    }

    let sink: Arc<dyn EventSink> = Arc::new(PoolTurnEventSink { app: app.clone() });
    let registry = build_koi_registry(&app, db.clone(), settings.clone(), sink.clone()).await;

    // Inject org_spec / assemble the member system prompt. Todo turns use the
    // kernel 6-layer contract (Stop Gate last); workflow agent nodes keep a
    // lighter stack.
    let extra_context = {
        let guard = db.lock().await;
        let pool_org = guard
            .get_pool_session(&request.pool_id)
            .ok()
            .flatten()
            .map(|s| s.org_spec)
            .filter(|s| !s.trim().is_empty());
        drop(guard);

        if request.todo_id.is_some() {
            let guard = db.lock().await;
            let koi = guard.get_koi(&request.koi_id).ok().flatten();
            let todo = request
                .todo_id
                .as_ref()
                .and_then(|id| guard.get_koi_todo(id).ok().flatten());
            match (koi, todo) {
                (Some(koi), Some(todo)) => {
                    let org_spec_ctx = pool_org
                        .as_deref()
                        .map(truncate_org_spec)
                        .filter(|s| !s.is_empty())
                        .map(|body| format!("\n\n## Project Organization\n{body}"))
                        .unwrap_or_default();
                    let assignment_ctx = format!(
                        "\n\n## Current Assignment\nTitle: {}\n{}\nTodo id: {}",
                        todo.title,
                        if todo.description.trim().is_empty() {
                            String::new()
                        } else {
                            format!("Description: {}\n", todo.description.trim())
                        },
                        todo.id
                    );
                    build_koi_task_system_prompt(
                        &koi.system_prompt,
                        &koi.name,
                        koi.icon.as_str(),
                        "",
                        "",
                        &org_spec_ctx,
                        "",
                        &assignment_ctx,
                    )
                }
                _ => {
                    let mut sections: Vec<String> = Vec::new();
                    let base = request.system_prompt.trim();
                    if !base.is_empty() {
                        sections.push(base.to_string());
                    }
                    if let Some(org) = pool_org.as_deref() {
                        sections.push(format!(
                            "## Project Organization\n{}",
                            truncate_org_spec(org)
                        ));
                    }
                    if let Some(extra) = request
                        .extra_system_context
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        sections.push(extra.to_string());
                    }
                    sections.join("\n\n")
                }
            }
        } else {
            let mut sections: Vec<String> = Vec::new();
            let base = request.system_prompt.trim();
            if !base.is_empty() {
                sections.push(base.to_string());
            }
            if let Some(org) = pool_org.as_deref() {
                sections.push(format!(
                    "## Project Organization\n{}",
                    truncate_org_spec(org)
                ));
            }
            if let Some(extra) = request
                .extra_system_context
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                sections.push(extra.to_string());
            }
            sections.join("\n\n")
        }
    };

    let cli_request = HeadlessCliRequest {
        prompt: request.user_prompt.clone(),
        workspace: Some(project_dir),
        mode: HeadlessCliMode::Piscis,
        session_id: Some(request.session_id.clone()),
        session_title: Some(format!("Assistant {}", request.koi_id)),
        channel: Some("pool".to_string()),
        pool_id: Some(request.pool_id.clone()),
        task_timeout_secs: request.task_timeout_secs,
        extra_system_context: Some(extra_context),
        ..Default::default()
    };

    let mut deps = HeadlessDeps::new(db, settings, registry, sink);
    if let Some(secs) = request.task_timeout_secs.filter(|s| *s > 0) {
        deps.default_timeout = Duration::from_secs(u64::from(secs));
    }

    match run_piscis_turn_cancellable(cli_request, deps, cancel.clone()).await {
        Ok(resp) => {
            let was_cancelled = cancel.load(Ordering::SeqCst);
            Ok(KoiTurnOutcome {
                handle,
                exit_kind: if was_cancelled {
                    KoiTurnExit::Cancelled
                } else {
                    KoiTurnExit::Completed
                },
                response_text: resp.response_text,
                error: was_cancelled.then(|| "cancelled".to_string()),
                exit_code: Some(0),
            })
        }
        Err(error) => {
            let was_cancelled = cancel.load(Ordering::SeqCst);
            Ok(KoiTurnOutcome {
                handle,
                exit_kind: if was_cancelled {
                    KoiTurnExit::Cancelled
                } else {
                    KoiTurnExit::Crashed
                },
                response_text: String::new(),
                error: Some(error.to_string()),
                exit_code: Some(1),
            })
        }
    }
}

/// Clip org_spec with a pointer to pool_org(read) when truncated.
fn truncate_org_spec(content: &str) -> String {
    const MAX: usize = 12000;
    if MAX == 0 || content.chars().count() <= MAX {
        return content.to_string();
    }
    format!(
        "{}...\n\n## (org_spec truncated, see pool org_spec action)\n\
         Use pool_org(action=\"read\") to load the full organization contract when needed.",
        content.chars().take(MAX).collect::<String>()
    )
}

fn cancelled_outcome(handle: KoiTurnHandle, reason: &str) -> KoiTurnOutcome {
    KoiTurnOutcome {
        handle,
        exit_kind: KoiTurnExit::Cancelled,
        response_text: String::new(),
        error: Some(reason.to_string()),
        exit_code: Some(0),
    }
}

fn crashed_outcome(handle: KoiTurnHandle, reason: &str) -> KoiTurnOutcome {
    KoiTurnOutcome {
        handle,
        exit_kind: KoiTurnExit::Crashed,
        response_text: String::new(),
        error: Some(reason.to_string()),
        exit_code: Some(1),
    }
}
