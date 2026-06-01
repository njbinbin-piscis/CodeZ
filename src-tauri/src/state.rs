//! Shared application state for the CodeZ desktop host.
//!
//! Deliberately small: only what the IDE workspace commands need. As later
//! milestones land (agent runtime, indexing, settings) this grows alongside
//! them, but the IDE surface stays self-contained here.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

use pisci_kernel::agent::plan::new_plan_store;
use pisci_kernel::agent::plan::PlanStore;

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
    /// Cancel flag for the in-flight chat turn (CodeZ runs one at a time).
    /// `Some` while a turn is running; the chat panel's Stop flips it.
    pub chat_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    /// Per-session plan board state for `plan_todo`.
    pub plan_state: PlanStore,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(TerminalRegistry::new())),
            file_watchers: Arc::new(Mutex::new(HashMap::new())),
            lsp_manager: Arc::new(LspManager::new()),
            chat_cancel: Arc::new(Mutex::new(None)),
            plan_state: new_plan_store(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
