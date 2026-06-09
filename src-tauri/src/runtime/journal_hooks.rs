//! Agent hooks: journal + IDE refresh + skill write guards + compaction memory triggers.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use once_cell::sync::Lazy;
use piscis_kernel::agent::file_journal::FileJournal;
use piscis_kernel::agent::hooks::{AgentHooks, ContextHookEvent, HookDecision, ToolHookEvent};
use piscis_kernel::agent::tool::ToolResult;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

const FILE_TOOLS: &[&str] = &["file_write", "file_edit"];
const COMPACTION_CONSOLIDATION_THRESHOLD: u32 = 3;

static SESSION_COMPACTION_COUNTS: Lazy<Mutex<HashMap<String, u32>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub struct JournalWithIdeNotify {
    journal: Arc<FileJournal>,
    app: AppHandle,
    project_db: Option<Arc<AsyncMutex<piscis_kernel::store::db::Database>>>,
}

impl JournalWithIdeNotify {
    pub fn new(
        journal: Arc<FileJournal>,
        app: AppHandle,
        project_db: Option<Arc<AsyncMutex<piscis_kernel::store::db::Database>>>,
    ) -> Self {
        Self {
            journal,
            app,
            project_db,
        }
    }

    fn rel_path(workspace_root: &std::path::Path, raw: &str) -> Option<String> {
        let p = std::path::Path::new(raw);
        let rel = p
            .strip_prefix(workspace_root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        let rel = rel.trim_start_matches('/').to_string();
        if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
            return None;
        }
        Some(rel)
    }

    fn emit_file_changed(&self, ev: &ToolHookEvent<'_>, kind: &str) {
        let Some(path) = ev
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .and_then(|raw| Self::rel_path(ev.workspace_root, raw))
        else {
            return;
        };
        if !crate::path_filter::should_watch_path(&path) {
            return;
        }
        let project_dir = ev.workspace_root.to_string_lossy().to_string();
        let _ = self.app.emit(
            "ide-file-changed",
            serde_json::json!({
                "project_dir": project_dir,
                "path": path,
                "kind": kind,
            }),
        );
    }

    fn is_locked_skill_path(path: &str) -> bool {
        let normalized = path.replace('\\', "/").to_lowercase();
        normalized.contains("/skills/installed/")
            || normalized.contains("/skills/.hub/")
            || (normalized.ends_with("/skill.md") && normalized.contains("/skills/"))
    }
}

#[async_trait]
impl AgentHooks for JournalWithIdeNotify {
    async fn before_tool(&self, ev: &ToolHookEvent<'_>) -> HookDecision {
        if FILE_TOOLS.contains(&ev.tool_name) {
            if let Some(path) = ev.input.get("path").and_then(|v| v.as_str()) {
                if Self::is_locked_skill_path(path) {
                    return HookDecision::Deny(
                        "Cannot modify locked skill files via file_write/file_edit. Use skill_manage for draft/learned skills.".into(),
                    );
                }
            }
        }
        self.journal.before_tool(ev).await
    }

    async fn after_tool(&self, ev: &ToolHookEvent<'_>, result: &ToolResult) {
        self.journal.after_tool(ev, result).await;
        if result.is_error || !FILE_TOOLS.contains(&ev.tool_name) {
            return;
        }
        self.emit_file_changed(ev, "modified");
    }

    async fn on_context_event(&self, ev: &ContextHookEvent<'_>) {
        if let ContextHookEvent::AfterCompact { session_id, .. } = ev {
            let count = {
                let mut counts = SESSION_COMPACTION_COUNTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let entry = counts.entry(session_id.to_string()).or_insert(0);
                *entry = entry.saturating_add(1);
                *entry
            };
            if count >= COMPACTION_CONSOLIDATION_THRESHOLD {
                SESSION_COMPACTION_COUNTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(*session_id);
                if let Some(db) = self.project_db.clone() {
                    let sid = session_id.to_string();
                    let app = self.app.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            crate::commands::memory_consolidate::for_session(&app, db, &sid).await
                        {
                            tracing::debug!(
                                "session memory consolidation skipped for {}: {}",
                                sid,
                                e
                            );
                        }
                    });
                }
            }
        }
    }
}
