//! `delegate` — spawn a focused read-only research sub-agent (M7).
//!
//! Lets the main Agent hand off a scoped investigation ("find where X is
//! implemented", "summarise how Y works") to a child agent that runs the
//! kernel agent loop with a bounded budget and a read-only tool surface. The
//! child's findings come back as this tool's result, keeping the parent's
//! context focused. This is CodeZ's in-process take on SubAgent delegation,
//! reusing [`crate::commands::chat_turn::run_subagent_research`].

use std::sync::Arc;

use async_trait::async_trait;
use pisci_kernel::agent::plan::PlanStore;
use pisci_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use pisci_kernel::store::settings::Settings;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::commands::chat_turn::run_subagent_research;
use crate::lsp::manager::LspManager;

pub struct DelegateTool {
    pub db: Arc<Mutex<pisci_kernel::store::db::Database>>,
    pub settings: Arc<Mutex<Settings>>,
    pub plan_store: PlanStore,
    pub lsp_manager: Arc<LspManager>,
}

#[async_trait]
impl Tool for DelegateTool {
    fn name(&self) -> &str {
        "delegate"
    }

    fn description(&self) -> &str {
        "Delegate a scoped, READ-ONLY investigation to a focused sub-agent and \
         get back its findings. Use this to parallelise/offload research that \
         would otherwise bloat your own context — e.g. 'find every call site of \
         function X', 'summarise how the auth flow works', 'locate the config \
         that controls Y'. The sub-agent can read and search the workspace but \
         cannot modify files or run commands, and it cannot delegate further.\n\
         \n\
         Parameters:\n\
         - 'task' (string): a self-contained brief. Include enough context that \
           the sub-agent can work without your conversation history.\n\
         \n\
         Output: the sub-agent's findings report. Act on it yourself."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Self-contained research brief for the sub-agent."
                }
            },
            "required": ["task"]
        })
    }

    fn is_read_only(&self) -> bool {
        // The delegated sub-agent is itself read-only, so delegating is safe to
        // run concurrently with other read-only tools.
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let task = input
            .get("task")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if task.is_empty() {
            return Ok(ToolResult::err("'task' parameter is required"));
        }

        let workspace = ctx.workspace_root.to_string_lossy().to_string();
        let findings = run_subagent_research(
            self.db.clone(),
            self.settings.clone(),
            self.plan_store.clone(),
            self.lsp_manager.clone(),
            workspace,
            task,
            ctx.cancel.clone(),
        )
        .await;

        match findings {
            Ok(text) if text.trim().is_empty() => {
                Ok(ToolResult::ok("[sub-agent returned no findings]".to_string()))
            }
            Ok(text) => Ok(ToolResult::ok(format!("Sub-agent findings:\n\n{text}"))),
            Err(e) => Ok(ToolResult::err(format!("delegate failed: {e}"))),
        }
    }
}
