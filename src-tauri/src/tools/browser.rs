//! `browser` — agent automation over the embedded Chromium (CDP).
//!
//! Drives the same headless page the IDE Browser panel shows, so the agent can
//! navigate, click, type, read text, screenshot, and run assertions for
//! end-to-end / UI testing. Backed by the shared [`BrowserManager`].

use std::path::PathBuf;

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use crate::browser::BrowserManager;

pub struct BrowserTool {
    pub manager: BrowserManager,
    /// Directory screenshots are written to (`{config}/browser-shots`).
    pub shots_dir: Option<PathBuf>,
}

#[async_trait]
impl Tool for BrowserTool {
    fn name(&self) -> &str {
        "browser"
    }

    fn description(&self) -> &str {
        "Drive a real headless Chromium browser for UI / end-to-end testing and \
         web automation. All actions run against one shared page that the user \
         also sees in the IDE Browser panel.\n\
         \n\
         Actions (field 'action'):\n\
         - 'navigate' { url }: load a URL, wait for it to settle.\n\
         - 'screenshot' {}: capture the page to a PNG file; returns its path.\n\
         - 'click' { selector }: click the first element matching a CSS selector.\n\
         - 'type' { selector, text, submit? }: focus the element, type text, and \
           optionally press Enter (submit=true).\n\
         - 'get_text' { selector? }: return innerText of a selector (or the page).\n\
         - 'eval' { script }: evaluate a JS expression and return its JSON value.\n\
         - 'assert' { selector?, contains? }: pass if the selector exists and/or \
           the page (or selector) text contains a substring.\n\
         - 'current_url' {}: the page's current URL.\n\
         - 'close' {}: shut the browser down."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["navigate", "screenshot", "click", "type", "get_text", "eval", "assert", "current_url", "close"],
                    "description": "Which browser action to perform."
                },
                "url": { "type": "string", "description": "For 'navigate'." },
                "selector": { "type": "string", "description": "CSS selector for click/type/get_text/assert." },
                "text": { "type": "string", "description": "For 'type': text to enter." },
                "submit": { "type": "boolean", "description": "For 'type': press Enter after typing." },
                "script": { "type": "string", "description": "For 'eval': a JS expression." },
                "contains": { "type": "string", "description": "For 'assert': substring expected in the text." }
            },
            "required": ["action"]
        })
    }

    fn is_read_only(&self) -> bool {
        // navigate/click/type mutate page state — keep this off the read-only
        // concurrency fast-path so actions run serially in order.
        false
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let str_arg = |k: &str| input.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());

        match action {
            "navigate" => {
                let Some(url) = str_arg("url") else {
                    return Ok(ToolResult::err("'url' is required for navigate"));
                };
                match self.manager.navigate(&url).await {
                    Ok(final_url) => Ok(ToolResult::ok(format!("Navigated to {final_url}"))),
                    Err(e) => Ok(ToolResult::err(format!("navigate failed: {e}"))),
                }
            }
            "screenshot" => match self.manager.screenshot_png_bytes().await {
                Ok(bytes) => {
                    let dir = self
                        .shots_dir
                        .clone()
                        .unwrap_or_else(|| std::env::temp_dir().join("codez-browser-shots"));
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        return Ok(ToolResult::err(format!("create shots dir failed: {e}")));
                    }
                    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
                    let path = dir.join(format!("shot-{ts}.png"));
                    match std::fs::write(&path, &bytes) {
                        Ok(_) => Ok(ToolResult::ok(format!(
                            "Screenshot saved to {} ({} bytes). Use file_read on this path if you need to view it.",
                            path.display(),
                            bytes.len()
                        ))),
                        Err(e) => Ok(ToolResult::err(format!("write screenshot failed: {e}"))),
                    }
                }
                Err(e) => Ok(ToolResult::err(format!("screenshot failed: {e}"))),
            },
            "click" => {
                let Some(selector) = str_arg("selector") else {
                    return Ok(ToolResult::err("'selector' is required for click"));
                };
                match self.manager.click_selector(&selector).await {
                    Ok(_) => Ok(ToolResult::ok(format!("Clicked '{selector}'"))),
                    Err(e) => Ok(ToolResult::err(format!("click failed: {e}"))),
                }
            }
            "type" => {
                let Some(selector) = str_arg("selector") else {
                    return Ok(ToolResult::err("'selector' is required for type"));
                };
                let text = str_arg("text").unwrap_or_default();
                let submit = input.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
                match self.manager.type_into(&selector, &text, submit).await {
                    Ok(_) => Ok(ToolResult::ok(format!(
                        "Typed into '{selector}'{}",
                        if submit { " and submitted" } else { "" }
                    ))),
                    Err(e) => Ok(ToolResult::err(format!("type failed: {e}"))),
                }
            }
            "get_text" => {
                let selector = str_arg("selector");
                match self.manager.get_text(selector.as_deref()).await {
                    Ok(text) => {
                        let trimmed: String = text.chars().take(8_000).collect();
                        Ok(ToolResult::ok(if trimmed.is_empty() {
                            "[no text]".to_string()
                        } else {
                            trimmed
                        }))
                    }
                    Err(e) => Ok(ToolResult::err(format!("get_text failed: {e}"))),
                }
            }
            "eval" => {
                let Some(script) = str_arg("script") else {
                    return Ok(ToolResult::err("'script' is required for eval"));
                };
                match self.manager.eval(&script).await {
                    Ok(val) => Ok(ToolResult::ok(
                        serde_json::to_string(&val).unwrap_or_else(|_| "null".into()),
                    )),
                    Err(e) => Ok(ToolResult::err(format!("eval failed: {e}"))),
                }
            }
            "assert" => {
                let selector = str_arg("selector");
                let contains = str_arg("contains");
                if selector.is_none() && contains.is_none() {
                    return Ok(ToolResult::err(
                        "'assert' needs at least one of 'selector' or 'contains'",
                    ));
                }
                let text = match self.manager.get_text(selector.as_deref()).await {
                    Ok(t) => t,
                    Err(e) => return Ok(ToolResult::err(format!("assert failed: {e}"))),
                };
                if let Some(sel) = &selector {
                    if text.is_empty() {
                        return Ok(ToolResult::err(format!(
                            "ASSERT FAILED: no element matched '{sel}' (or it had no text)"
                        )));
                    }
                }
                if let Some(needle) = &contains {
                    if !text.contains(needle.as_str()) {
                        return Ok(ToolResult::err(format!(
                            "ASSERT FAILED: expected text to contain '{needle}'"
                        )));
                    }
                }
                Ok(ToolResult::ok("ASSERT PASSED"))
            }
            "current_url" => match self.manager.current_url().await {
                Ok(url) => Ok(ToolResult::ok(url)),
                Err(e) => Ok(ToolResult::err(format!("current_url failed: {e}"))),
            },
            "close" => match self.manager.close().await {
                Ok(_) => Ok(ToolResult::ok("Browser closed")),
                Err(e) => Ok(ToolResult::err(format!("close failed: {e}"))),
            },
            other => Ok(ToolResult::err(format!(
                "unknown action '{other}'. Valid: navigate, screenshot, click, type, get_text, eval, assert, current_url, close"
            ))),
        }
    }
}
