//! Tauri events emitted when the agent or panel mutates the shared browser page.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const BROWSER_CHANGED: &str = "browser-changed";

/// Emit after a successful `browser` tool call so the IDE panel can refresh immediately.
pub fn emit_browser_changed(app: &AppHandle, input: &Value, session_id: Option<&str>) {
    let payload = json!({
        "action": input.get("action").and_then(|v| v.as_str()).unwrap_or("unknown"),
        "url": input.get("url").and_then(|v| v.as_str()),
        "selector": input.get("selector").and_then(|v| v.as_str()),
        "ref": input.get("ref").and_then(|v| v.as_str()),
        "session_id": session_id,
    });
    let _ = app.emit(BROWSER_CHANGED, payload);
}
