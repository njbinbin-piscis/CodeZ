//! `web_fetch` — fetch and extract readable text from a URL (Cursor WebFetch equivalent).
//!
//! Complements kernel `web_search`: use search to discover links, then fetch to
//! read documentation, release notes, or API reference pages.

use async_trait::async_trait;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_CHARS: usize = 32_000;
const TIMEOUT_SECS: u64 = 30;

pub struct WebFetchTool;

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }

    fn description(&self) -> &str {
        "Fetch a URL and return its main text content (HTML is stripped to plain text). \
         Use after `web_search` when you have a specific link to read — docs, changelogs, \
         API references, GitHub issues.\n\
         \n\
         Parameters:\n\
         - 'url' (string): http or https URL.\n\
         - 'max_chars' (number): truncate output (default 32000).\n\
         \n\
         Output: page title (if found) plus extracted text."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "HTTP or HTTPS URL to fetch."
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum characters to return (default 32000)."
                }
            },
            "required": ["url"]
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let url = input
            .get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .trim();
        if url.is_empty() {
            return Ok(ToolResult::err("'url' parameter is required"));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Ok(ToolResult::err(
                "Only http:// and https:// URLs are supported",
            ));
        }

        let max_chars = input
            .get("max_chars")
            .and_then(|n| n.as_u64())
            .unwrap_or(DEFAULT_MAX_CHARS as u64)
            .clamp(1_000, 100_000) as usize;

        let client = Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .user_agent("CodeZ/1.0 (+https://github.com/njbinbin-piscis/CodeZ)")
            .build()
            .map_err(|e| anyhow::anyhow!("HTTP client: {e}"))?;

        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Request failed: {e}"))?;

        if !resp.status().is_success() {
            return Ok(ToolResult::err(format!(
                "HTTP {} for {}",
                resp.status(),
                url
            )));
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| anyhow::anyhow!("Read body: {e}"))?;
        if bytes.len() > MAX_BYTES {
            return Ok(ToolResult::err(format!(
                "Response too large ({} bytes, max {})",
                bytes.len(),
                MAX_BYTES
            )));
        }

        let body = String::from_utf8_lossy(&bytes);
        let (title, text) = if content_type.contains("html") || looks_like_html(&body) {
            extract_html(&body)
        } else {
            (None, body.trim().to_string())
        };

        let mut out = String::new();
        if let Some(t) = title.filter(|s| !s.is_empty()) {
            out.push_str("# ");
            out.push_str(&t);
            out.push_str("\n\n");
        }
        out.push_str(&text);
        if out.chars().count() > max_chars {
            out = out.chars().take(max_chars).collect();
            out.push_str("\n\n[truncated]");
        }

        Ok(ToolResult::ok(out))
    }
}

fn looks_like_html(body: &str) -> bool {
    let lower = body.get(..256).unwrap_or(body).to_ascii_lowercase();
    lower.contains("<html") || lower.contains("<!doctype")
}

fn extract_html(html: &str) -> (Option<String>, String) {
    let title = extract_tag_text(html, "title");
    // Drop script/style blocks before tag stripping.
    let mut s = html.to_string();
    for tag in ["script", "style", "noscript"] {
        s = remove_balanced_tags(&s, tag);
    }
    let text = html_to_text(&s);
    (title, collapse_blank_lines(&text))
}

fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = html.to_ascii_lowercase().find(&open)?;
    let after_open = &html[start..];
    let content_start = after_open.find('>')? + 1;
    let rest = &after_open[content_start..];
    let close = format!("</{tag}>");
    let end = rest.to_ascii_lowercase().find(&close)?;
    Some(decode_entities(rest[..end].trim()))
}

fn remove_balanced_tags(html: &str, tag: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    let open_lower = format!("<{tag}");
    let close_lower = format!("</{tag}>");

    while let Some(start) = rest.to_ascii_lowercase().find(&open_lower) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(gt) = after.find('>') else {
            break;
        };
        let inner = &after[gt + 1..];
        if let Some(close_at) = inner.to_ascii_lowercase().find(&close_lower) {
            rest = &inner[close_at + close_lower.len()..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut tag_buf = String::new();
    let mut prev_space = false;

    for ch in html.chars() {
        if ch == '<' {
            if !in_tag {
                if matches!(
                    tag_buf.to_ascii_lowercase().as_str(),
                    "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                ) && !out.is_empty()
                {
                    out.push('\n');
                    prev_space = true;
                }
                tag_buf.clear();
            }
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if in_tag {
            if ch.is_ascii_alphabetic() || ch == '/' {
                tag_buf.push(ch);
            }
            continue;
        }
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    decode_entities(out.trim())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn collapse_blank_lines(s: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut blank_run = 0usize;
    for line in s.lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                lines.push("");
            }
        } else {
            blank_run = 0;
            lines.push(line.trim_end());
        }
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_basic_html() {
        let html = "<html><body><p>Hello <b>world</b></p></body></html>";
        let (_, text) = extract_html(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("world"));
        assert!(!text.contains("<p>"));
    }
}
