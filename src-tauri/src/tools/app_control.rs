//! `app_control` — let the agent manage the app on the user's behalf: read and
//! update system settings, and create assistants (single agents) and teams.
//!
//! Mirrors the spirit of OpenPiscis' `app_control`, but scoped to the AgentZ
//! desktop surface: settings live in the global `config.json`, assistants are
//! agent manifests (`{config}/agents/<id>/agent.json`), and teams are Pool
//! templates (`{config}/teams/<id>/team.json`).

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use piscis_kernel::store::settings::Settings;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::commands::agents::{agents_list, agents_save, AgentManifest};
use crate::commands::data_scope::resolve_global_config_dir;
use crate::commands::teams::{teams_list, teams_save, TeamManifest};

/// Tauri event so open panels reload after the agent mutates settings/agents.
pub const APP_CONTROL_UPDATED_EVENT: &str = "agentz:app-control-updated";

pub struct AppControlTool {
    pub app: AppHandle,
}

/// Recursively merge `patch` into `base` (objects deep-merge, everything else
/// overwrites). Used to apply a partial settings update without enumerating
/// every field.
fn deep_merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                deep_merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (b, p) => *b = p.clone(),
    }
}

impl AppControlTool {
    fn config_path(&self) -> Result<std::path::PathBuf, String> {
        Ok(resolve_global_config_dir(&self.app)?.join("config.json"))
    }

    async fn get_settings(&self) -> anyhow::Result<ToolResult> {
        let path = self.config_path().map_err(|e| anyhow::anyhow!(e))?;
        let settings = Settings::load(&path).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let mut value = serde_json::to_value(&settings)?;
        // Never echo secrets back to the model.
        redact_secrets(&mut value);
        Ok(ToolResult::ok(serde_json::to_string_pretty(&value)?))
    }

    async fn update_settings(&self, patch: &Value) -> anyhow::Result<ToolResult> {
        if !patch.is_object() {
            return Ok(ToolResult::err(
                "`settings` must be a JSON object of fields to change.",
            ));
        }
        let path = self.config_path().map_err(|e| anyhow::anyhow!(e))?;
        let settings = Settings::load(&path).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let mut value = serde_json::to_value(&settings)?;
        deep_merge(&mut value, patch);
        let mut merged: Settings = serde_json::from_value(value)
            .map_err(|e| anyhow::anyhow!("invalid settings after merge: {e}"))?;
        merged.config_path = path;
        merged.save().map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let _ = self
            .app
            .emit(APP_CONTROL_UPDATED_EVENT, json!({ "kind": "settings" }));
        let changed: Vec<String> = patch
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        Ok(ToolResult::ok(format!(
            "Settings updated ({} field(s)): {}",
            changed.len(),
            changed.join(", ")
        )))
    }

    async fn create_assistant(&self, spec: &Value) -> anyhow::Result<ToolResult> {
        let manifest: AgentManifest = serde_json::from_value(spec.clone())
            .map_err(|e| anyhow::anyhow!("invalid assistant spec: {e}"))?;
        if manifest.id.trim().is_empty() || manifest.name.trim().is_empty() {
            return Ok(ToolResult::err(
                "assistant requires non-empty `id` and `name`.",
            ));
        }
        let info = agents_save(self.app.clone(), manifest)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        let _ = self
            .app
            .emit(APP_CONTROL_UPDATED_EVENT, json!({ "kind": "assistant" }));
        Ok(ToolResult::ok(format!(
            "Assistant '{}' ({}) saved.",
            info.name, info.id
        )))
    }

    async fn create_team(&self, spec: &Value) -> anyhow::Result<ToolResult> {
        let manifest: TeamManifest = serde_json::from_value(spec.clone())
            .map_err(|e| anyhow::anyhow!("invalid team spec: {e}"))?;
        if manifest.id.trim().is_empty() || manifest.name.trim().is_empty() {
            return Ok(ToolResult::err("team requires non-empty `id` and `name`."));
        }
        let info = teams_save(self.app.clone(), manifest)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        let _ = self
            .app
            .emit(APP_CONTROL_UPDATED_EVENT, json!({ "kind": "team" }));
        Ok(ToolResult::ok(format!(
            "Team '{}' ({}) saved with {} member(s).",
            info.name,
            info.id,
            info.members.len()
        )))
    }

    async fn list_assistants(&self) -> anyhow::Result<ToolResult> {
        let list = agents_list(self.app.clone())
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(ToolResult::ok(serde_json::to_string_pretty(&list)?))
    }

    async fn list_teams(&self) -> anyhow::Result<ToolResult> {
        let list = teams_list(self.app.clone())
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(ToolResult::ok(serde_json::to_string_pretty(&list)?))
    }
}

/// Blank out obvious secret fields before returning settings to the model.
fn redact_secrets(value: &mut Value) {
    const SECRET_HINTS: &[&str] = &["api_key", "secret", "token", "password", "private_key"];
    if let Value::Object(map) = value {
        for (k, v) in map.iter_mut() {
            let lk = k.to_lowercase();
            if SECRET_HINTS.iter().any(|h| lk.contains(h)) {
                if let Value::String(s) = v {
                    if !s.is_empty() {
                        *s = "***".to_string();
                    }
                }
            } else {
                redact_secrets(v);
            }
        }
    } else if let Value::Array(arr) = value {
        for v in arr.iter_mut() {
            redact_secrets(v);
        }
    }
}

#[async_trait]
impl Tool for AppControlTool {
    fn name(&self) -> &str {
        "app_control"
    }

    fn description(&self) -> &str {
        "Manage the desktop app on the user's behalf: read/update system settings and \
         create assistants (single agents) and teams.\n\
         \n\
         Set `action` to one of:\n\
         - `get_settings`: return the current settings (secrets redacted).\n\
         - `update_settings`: deep-merge the `settings` object into config.json and save. \
           Only include the fields you want to change, e.g. {\"policy_mode\":\"auto\", \
           \"enable_streaming\":true, \"language\":\"zh\", \"vision_enabled\":true}.\n\
         - `list_assistants` / `list_teams`: enumerate existing definitions.\n\
         - `create_assistant`: upsert an assistant from the `assistant` object \
           (fields: id, name, role, description, system_prompt, skills[], tools[], \
           mcp_servers[], connectors[], llm_provider_id).\n\
         - `create_team`: upsert a team from the `team` object (fields: id, name, \
           description, mode ['swarm'|'workflow'], org_spec, members[] of assistant ids, \
           workflow_hint ['waves'|'sequential'|'review']).\n\
         \n\
         Always confirm destructive or far-reaching settings changes with the user first."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get_settings",
                        "update_settings",
                        "list_assistants",
                        "list_teams",
                        "create_assistant",
                        "create_team"
                    ],
                    "description": "Which operation to perform."
                },
                "settings": {
                    "type": "object",
                    "description": "For update_settings: partial settings object to deep-merge."
                },
                "assistant": {
                    "type": "object",
                    "description": "For create_assistant: the assistant (agent) manifest."
                },
                "team": {
                    "type": "object",
                    "description": "For create_team: the team manifest."
                }
            },
            "required": ["action"]
        })
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        match action {
            "get_settings" => self.get_settings().await,
            "update_settings" => {
                let patch = input.get("settings").cloned().unwrap_or(Value::Null);
                self.update_settings(&patch).await
            }
            "list_assistants" => self.list_assistants().await,
            "list_teams" => self.list_teams().await,
            "create_assistant" => {
                let spec = input.get("assistant").cloned().unwrap_or(Value::Null);
                if spec.is_null() {
                    return Ok(ToolResult::err("`assistant` object is required."));
                }
                self.create_assistant(&spec).await
            }
            "create_team" => {
                let spec = input.get("team").cloned().unwrap_or(Value::Null);
                if spec.is_null() {
                    return Ok(ToolResult::err("`team` object is required."));
                }
                self.create_team(&spec).await
            }
            other => Ok(ToolResult::err(format!(
                "Unknown action '{other}'. Use one of: get_settings, update_settings, \
                 list_assistants, list_teams, create_assistant, create_team."
            ))),
        }
    }
}
