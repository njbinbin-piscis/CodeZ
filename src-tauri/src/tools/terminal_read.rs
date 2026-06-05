//! `terminal_read` — read recent PTY output from embedded IDE terminals.

use std::sync::Arc;

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::commands::ide::TerminalRegistry;

pub struct TerminalReadTool {
    pub terminals: Arc<Mutex<TerminalRegistry>>,
}

#[async_trait]
impl Tool for TerminalReadTool {
    fn name(&self) -> &str {
        "terminal_read"
    }

    fn description(&self) -> &str {
        "Read recent output from the IDE's embedded terminal (PTY) sessions.\n\
         \n\
         - `lines` (default 50): return the last N lines of output.\n\
         - `grep` + `grep_lines` (default 100): search for a substring in the \
           last M lines and return matching lines only.\n\
         - `terminal_id`: optional session id; defaults to the first live session.\n\
         \n\
         Output is captured server-side as the terminal runs — use this to inspect \
         build logs, test failures, or runtime errors without re-running commands."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "terminal_id": {
                    "type": "string",
                    "description": "Terminal session id (omit to use the first live session)."
                },
                "lines": {
                    "type": "integer",
                    "description": "Number of trailing lines to return (default 50)."
                },
                "grep": {
                    "type": "string",
                    "description": "Substring to search for in recent output."
                },
                "grep_lines": {
                    "type": "integer",
                    "description": "When grep is set, how many recent lines to search (default 100)."
                }
            }
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let terminal_id = input
            .get("terminal_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let lines = input
            .get("lines")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let grep = input
            .get("grep")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let grep_lines = input
            .get("grep_lines")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);

        let registry = self.terminals.lock().await;
        let tid = if let Some(id) = terminal_id.filter(|s| !s.trim().is_empty()) {
            id
        } else {
            registry
                .sessions
                .keys()
                .next()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no terminal sessions are running"))?
        };
        let session = registry
            .sessions
            .get(&tid)
            .ok_or_else(|| anyhow::anyhow!("terminal '{tid}' not found"))?;
        let log = session
            .output
            .lock()
            .map_err(|e| anyhow::anyhow!("terminal output lock poisoned: {e}"))?;
        let out = if let Some(pattern) = grep.filter(|s| !s.is_empty()) {
            let window = grep_lines.unwrap_or(100).clamp(1, 5000);
            log.grep_in_tail(&pattern, window)
        } else {
            let n = lines.unwrap_or(50).clamp(1, 5000);
            log.tail(n)
        };

        if out.is_empty() {
            Ok(ToolResult::ok(format!(
                "Terminal '{tid}' has no captured output yet."
            )))
        } else {
            Ok(ToolResult::ok(format!("--- terminal:{tid} ---\n{out}")))
        }
    }
}
