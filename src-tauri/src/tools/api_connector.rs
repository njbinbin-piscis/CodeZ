//! `api_connector` — list and call user-configured HTTP API connectors (video,
//! ASR, TTS, OCR, and other external services defined in Settings → Connectors).

use std::path::PathBuf;

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use crate::commands::connectors::{call_api_connector, list_api_connectors};

pub struct ApiConnectorTool {
    pub config_dir: PathBuf,
}

#[async_trait]
impl Tool for ApiConnectorTool {
    fn name(&self) -> &str {
        "api_connector"
    }

    fn description(&self) -> &str {
        "List or call HTTP API connectors configured in Settings → Connectors \
         (e.g. video generation, ASR, TTS, OCR).\n\
         \n\
         Parameters:\n\
         - 'action' (string): 'list' or 'call' (default 'list').\n\
         - 'connector_id' (string): required for 'call'.\n\
         - 'body' (object): JSON request body for POST/PUT calls (optional).\n\
         \n\
         Use 'list' first to discover connector ids, use_case, and parameters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "call"],
                    "description": "list available API connectors, or call one."
                },
                "connector_id": {
                    "type": "string",
                    "description": "Connector id (from list action)."
                },
                "body": {
                    "type": "object",
                    "description": "JSON body for POST/PUT API calls."
                }
            }
        })
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("list");

        if action == "list" {
            let entries = list_api_connectors(&self.config_dir);
            if entries.is_empty() {
                return Ok(ToolResult::ok(
                    "No enabled API connectors. Add one in Settings → Connectors → New API connector.",
                ));
            }
            let lines: Vec<String> = entries
                .iter()
                .map(|e| {
                    format!(
                        "- {} (id: {}, method: {})\n  URL: {}\n  Use case: {}\n  Parameters: {}",
                        e.name, e.id, e.method, e.url, e.use_case, e.parameters
                    )
                })
                .collect();
            return Ok(ToolResult::ok(lines.join("\n\n")));
        }

        if action == "call" {
            let id = input
                .get("connector_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if id.is_empty() {
                return Ok(ToolResult::err(
                    "'connector_id' is required for action=call",
                ));
            }
            let body = input.get("body").cloned();
            match call_api_connector(&self.config_dir, id, body).await {
                Ok(text) => return Ok(ToolResult::ok(text)),
                Err(e) => return Ok(ToolResult::err(&e)),
            }
        }

        Ok(ToolResult::err("action must be 'list' or 'call'"))
    }
}
