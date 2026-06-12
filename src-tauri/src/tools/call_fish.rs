//! `call_fish` — invoke a named, stateless Fish sub-agent (Phase B).
//!
//! Mirrors [`crate::tools::delegate::DelegateTool`] but lets the main agent pick
//! a specialised persona (Scout / Summarizer / Extractor / user-defined) for a
//! result-first job. The Fish runs the read-only kernel agent loop on the flash
//! model and returns its final report. Only the main agent gets `call_fish`;
//! the sub-agent's own registry omits it, preventing recursion.

use std::sync::Arc;

use async_trait::async_trait;
use piscis_kernel::agent::plan::PlanStore;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use piscis_kernel::store::settings::Settings;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::commands::chat_turn::run_subagent_with_prompt;
use crate::commands::fish::{find_fish, load_fish_library};
use crate::commands::system_prompt::fish_system_prompt;
use crate::lsp::manager::LspManager;

pub struct CallFishTool {
    pub db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    pub settings: Arc<Mutex<Settings>>,
    pub plan_store: PlanStore,
    pub lsp_manager: Arc<LspManager>,
    pub app: tauri::AppHandle,
}

#[async_trait]
impl Tool for CallFishTool {
    fn name(&self) -> &str {
        "call_fish"
    }

    fn description(&self) -> &str {
        "Invoke a named, stateless sub-agent for a self-contained, \
         result-first job (scan, collect, summarize, extract). The sub-agent runs \
         READ-ONLY on a lightweight flash model and returns only its final \
         report — its steps never enter your context. It has NO access to your \
         conversation, so the brief must be complete.\n\
         \n\
         Parameters:\n\
         - 'action' (string): 'list' to see available sub-agents, or 'call' to run one.\n\
         - 'fish' (string): the sub-agent id (required for action=call).\n\
         - 'task' (string): a self-contained brief (required for action=call).\n\
         \n\
         Start with action=list if unsure which sub-agent fits."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "call"],
                    "description": "'list' available sub-agents, or 'call' one."
                },
                "fish": {
                    "type": "string",
                    "description": "Sub-agent id to run (action=call)."
                },
                "task": {
                    "type": "string",
                    "description": "Self-contained brief for the sub-agent (action=call)."
                }
            },
            "required": ["action"]
        })
    }

    fn is_read_only(&self) -> bool {
        // Builtin Fish are read-only, so calls are safe to run concurrently.
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("call")
            .trim()
            .to_lowercase();

        let config_dir = crate::commands::data_scope::resolve_global_config_dir(&self.app)
            .map_err(|e| anyhow::anyhow!(e))?;

        if action == "list" {
            let lib = load_fish_library(&config_dir);
            let lines: Vec<String> = lib
                .iter()
                .map(|f| format!("- {} ({}): {}", f.id, f.name, f.description))
                .collect();
            return Ok(ToolResult::ok(format!(
                "Available sub-agents:\n{}",
                lines.join("\n")
            )));
        }

        let fish_id = input
            .get("fish")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if fish_id.is_empty() {
            return Ok(ToolResult::err(
                "'fish' parameter is required for action=call (use action=list to discover ids)",
            ));
        }
        let task = input
            .get("task")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if task.is_empty() {
            return Ok(ToolResult::err(
                "'task' parameter is required for action=call",
            ));
        }

        let Some(fish) = find_fish(&config_dir, &fish_id) else {
            return Ok(ToolResult::err(format!(
                "unknown sub-agent '{fish_id}' — use action=list to see available ids"
            )));
        };

        let workspace = ctx.workspace_root.to_string_lossy().to_string();
        let system_prompt = fish_system_prompt(&workspace, &fish.name, &fish.system_prompt);

        let findings = run_subagent_with_prompt(
            self.app.clone(),
            self.db.clone(),
            self.settings.clone(),
            self.plan_store.clone(),
            self.lsp_manager.clone(),
            workspace,
            system_prompt,
            task,
            ctx.cancel.clone(),
        )
        .await;

        match findings {
            Ok(text) if text.trim().is_empty() => Ok(ToolResult::ok(format!(
                "[{} returned no findings]",
                fish.name
            ))),
            Ok(text) => Ok(ToolResult::ok(format!("{} report:\n\n{text}", fish.name))),
            Err(e) => Ok(ToolResult::err(format!("call_fish failed: {e}"))),
        }
    }
}
