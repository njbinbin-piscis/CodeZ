//! Shared application state for the CodeZ desktop host.
//!
//! Deliberately small: only what the IDE workspace commands need. As later
//! milestones land (agent runtime, indexing, settings) this grows alongside
//! them, but the IDE surface stays self-contained here.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{oneshot, Mutex, Semaphore};

use piscis_kernel::agent::plan::new_plan_store;
use piscis_kernel::agent::plan::PlanStore;

use crate::browser::BrowserManager;
use crate::commands::dap::DapManager;
use crate::commands::ext_host::ExtHostManager;
use crate::commands::ide::TerminalRegistry;
use crate::lsp::manager::LspManager;

/// Application state managed by Tauri and injected into commands via
/// `tauri::State<'_, AppState>`.
#[derive(Clone)]
pub struct AppState {
    /// Live PTY terminal sessions, keyed by frontend-generated terminal id.
    pub terminals: Arc<Mutex<TerminalRegistry>>,
    /// Active filesystem watchers, keyed by project directory.
    pub file_watchers: Arc<Mutex<HashMap<String, notify::RecommendedWatcher>>>,
    /// Language-server lifecycle manager (one bridge per project+language).
    pub lsp_manager: Arc<LspManager>,
    /// Cancel flag for the in-flight chat turn in the (sequential) IDE chat
    /// panel. `Some` while a turn is running; the chat panel's Stop flips it.
    pub chat_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    /// Per-task cancel flags for parallel Agent tasks (M7), keyed by a
    /// frontend-supplied task key so each isolated task can be stopped
    /// independently without affecting its siblings.
    pub task_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Bounds how many Agent turns run concurrently (M7 task queue). Extra
    /// submissions wait here until a permit frees up, so a flood of parallel
    /// tasks degrades gracefully instead of starving the machine.
    pub agent_slots: Arc<Semaphore>,
    /// Per-session plan todo list state for `plan_todo`.
    pub plan_state: PlanStore,
    /// Pending `chat_ui` / `chat_ui_listen` response channels keyed by request id.
    pub interactive_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// Embedded Chromium session shared by the Browser panel and the agent
    /// `browser` tool (lazily launched on first use).
    pub browser: BrowserManager,
    /// VS Code extension host sidecar lifecycle (Node process + RPC stdin).
    pub ext_host: Arc<ExtHostManager>,
    /// Debug Adapter Protocol broker (one active adapter at a time).
    pub dap: Arc<DapManager>,
    /// Ephemeral terminal text selections keyed by uuid (`@terminal-snippet(id)`).
    pub terminal_snippets: Arc<Mutex<HashMap<String, String>>>,
}

/// Default cap on concurrently running Agent turns. Overridable via the
/// `CODEZ_AGENT_CONCURRENCY` environment variable.
const DEFAULT_AGENT_CONCURRENCY: usize = 3;

fn agent_concurrency() -> usize {
    std::env::var("CODEZ_AGENT_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(DEFAULT_AGENT_CONCURRENCY)
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(TerminalRegistry::new())),
            file_watchers: Arc::new(Mutex::new(HashMap::new())),
            lsp_manager: Arc::new(LspManager::new()),
            chat_cancel: Arc::new(Mutex::new(None)),
            task_cancel: Arc::new(Mutex::new(HashMap::new())),
            agent_slots: Arc::new(Semaphore::new(agent_concurrency())),
            plan_state: new_plan_store(),
            interactive_responses: Arc::new(Mutex::new(HashMap::new())),
            browser: BrowserManager::new(),
            ext_host: Arc::new(ExtHostManager::new()),
            dap: Arc::new(DapManager::new()),
            terminal_snippets: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
