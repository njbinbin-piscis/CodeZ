//! `codebase_search` — agent tool for whole-repo semantic-ish recall (M5).
//!
//! Wraps [`crate::commands::codebase::search_index`] so both the IDE chat and
//! the Agent mode can find relevant code by meaning/keywords across the whole
//! workspace, instead of only `file_search` (ripgrep literal match). The index
//! is built lazily on first use and updated incrementally by the file watcher.

use async_trait::async_trait;
use pisci_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use crate::commands::codebase::search_index;

pub struct CodebaseSearchTool;

#[async_trait]
impl Tool for CodebaseSearchTool {
    fn name(&self) -> &str {
        "codebase_search"
    }

    fn description(&self) -> &str {
        "Search the entire workspace for code relevant to a natural-language \
         query, ranked by relevance across all files. Use this when you need to \
         find where something is implemented / used and you do NOT know the exact \
         string to grep for. Complements `file_search` (literal ripgrep match).\n\
         \n\
         Parameters:\n\
         - 'query' (string): what you're looking for, in words or symbol names.\n\
         - 'limit' (number): max results (default 12).\n\
         \n\
         Output: ranked `path:start-end` locations with a code snippet each."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Natural-language or keyword query." },
                "limit": { "type": "integer", "description": "Max results (default 12)." }
            },
            "required": ["query"]
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let query = input
            .get("query")
            .and_then(|q| q.as_str())
            .unwrap_or("")
            .to_string();
        if query.trim().is_empty() {
            return Ok(ToolResult::err("'query' parameter is required"));
        }
        let limit = input
            .get("limit")
            .and_then(|l| l.as_u64())
            .unwrap_or(12) as usize;

        let root = ctx.workspace_root.clone();
        let hits = match tokio::task::spawn_blocking(move || search_index(&root, &query, limit))
            .await
        {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Ok(ToolResult::err(format!("codebase_search failed: {e}"))),
            Err(e) => return Ok(ToolResult::err(format!("codebase_search task failed: {e}"))),
        };

        if hits.is_empty() {
            return Ok(ToolResult::ok("No matching code found in the index.".to_string()));
        }

        let mut out = format!("codebase_search: {} result(s)\n", hits.len());
        for h in &hits {
            out.push_str(&format!(
                "\n── {}:{}-{} (score {:.0})\n{}\n",
                h.path, h.start_line, h.end_line, h.score, h.snippet
            ));
        }
        Ok(ToolResult::ok(out))
    }
}
