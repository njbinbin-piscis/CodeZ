//! Headless Chromium driver (CDP via `chromiumoxide`).
//!
//! CodeZ embeds a real Chromium instance driven over the Chrome DevTools
//! Protocol — the same approach Cursor/Playwright use. The browser runs
//! headless; its frames are streamed into the IDE's Browser panel as PNG
//! screenshots, and pointer events from the panel are forwarded back. The
//! shared [`BrowserManager`] is also handed to the agent's `browser` tool so
//! automation (navigate / click / type / eval / screenshot) drives the exact
//! same page the user sees.
//!
//! One page/tab is kept live at a time. Launch is lazy: the first navigate (or
//! the panel opening) spawns Chromium; [`BrowserManager::close`] tears it down.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::Page;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// A picked DOM element returned to the frontend / agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PickedElement {
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
}

struct Live {
    browser: Browser,
    page: Page,
    handler_task: JoinHandle<()>,
}

/// Cloneable handle to the single live Chromium session. Stored in `AppState`
/// and shared with the agent `browser` tool.
#[derive(Clone, Default)]
pub struct BrowserManager {
    inner: Arc<Mutex<Option<Live>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Launch Chromium if not already running. Idempotent.
    async fn ensure(&self) -> Result<()> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let config = BrowserConfig::builder()
            .window_size(1280, 800)
            .build()
            .map_err(|e| anyhow!("browser config: {e}"))?;
        let (browser, mut handler) = Browser::launch(config)
            .await
            .context("failed to launch Chromium (is Chrome/Chromium installed?)")?;
        let handler_task = tokio::spawn(async move {
            while let Some(h) = handler.next().await {
                if h.is_err() {
                    break;
                }
            }
        });
        let page = browser
            .new_page("about:blank")
            .await
            .context("failed to open initial page")?;
        *guard = Some(Live {
            browser,
            page,
            handler_task,
        });
        Ok(())
    }

    /// Run a closure with the live page, launching first if needed.
    async fn with_page<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: FnOnce(Page) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        self.ensure().await?;
        let page = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .map(|l| l.page.clone())
                .ok_or_else(|| anyhow!("browser not initialised"))?
        };
        f(page).await
    }

    /// Navigate to `url` and wait for the load to settle. Returns the final URL.
    pub async fn navigate(&self, url: &str) -> Result<String> {
        let target = normalise_url(url);
        self.with_page(|page| async move {
            page.goto(target.as_str()).await.context("navigation failed")?;
            let _ = page.wait_for_navigation().await;
            current_url(&page).await
        })
        .await
    }

    /// Capture the current page as a base64-encoded PNG.
    pub async fn screenshot_png_base64(&self) -> Result<String> {
        use base64::Engine;
        let bytes = self
            .with_page(|page| async move {
                page.screenshot(
                    ScreenshotParams::builder()
                        .format(CaptureScreenshotFormat::Png)
                        .build(),
                )
                .await
                .context("screenshot failed")
            })
            .await?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Capture the current page as raw PNG bytes (for the agent tool to save).
    pub async fn screenshot_png_bytes(&self) -> Result<Vec<u8>> {
        self.with_page(|page| async move {
            page.screenshot(
                ScreenshotParams::builder()
                    .format(CaptureScreenshotFormat::Png)
                    .build(),
            )
            .await
            .context("screenshot failed")
        })
        .await
    }

    /// Evaluate a JS expression and return its JSON value.
    pub async fn eval(&self, script: &str) -> Result<serde_json::Value> {
        let script = script.to_string();
        self.with_page(|page| async move {
            let res = page
                .evaluate(script.as_str())
                .await
                .context("evaluate failed")?;
            Ok(res.into_value().unwrap_or(serde_json::Value::Null))
        })
        .await
    }

    /// Click whatever element is at viewport coordinates (x, y) — used to
    /// forward clicks from the panel screenshot.
    pub async fn click_at(&self, x: f64, y: f64) -> Result<bool> {
        let js = format!(
            "(() => {{ const el = document.elementFromPoint({x}, {y}); if (!el) return false; el.scrollIntoView({{block:'center',inline:'center'}}); el.click(); return true; }})()"
        );
        Ok(self.eval(&js).await?.as_bool().unwrap_or(false))
    }

    /// Identify the element at viewport coordinates (x, y) for "pick element".
    pub async fn pick_at(&self, x: f64, y: f64) -> Result<Option<PickedElement>> {
        let js = format!(
            r#"(() => {{
                const el = document.elementFromPoint({x}, {y});
                if (!el) return null;
                const sel = (e) => {{
                    if (e.id) return '#' + CSS.escape(e.id);
                    let s = e.tagName.toLowerCase();
                    if (e.classList && e.classList.length) {{
                        s += '.' + Array.from(e.classList).map(c => CSS.escape(c)).join('.');
                    }}
                    const p = e.parentElement;
                    if (p && p.tagName !== 'BODY' && p.tagName !== 'HTML') {{
                        const same = Array.from(p.children).filter(c => c.tagName === e.tagName);
                        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
                    }}
                    return s;
                }};
                return {{
                    selector: sel(el),
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || el.value || '').slice(0, 300),
                    html: el.outerHTML.slice(0, 600)
                }};
            }})()"#
        );
        let val = self.eval(&js).await?;
        if val.is_null() {
            return Ok(None);
        }
        Ok(serde_json::from_value(val).ok())
    }

    /// Click the first element matching a CSS selector (agent automation).
    pub async fn click_selector(&self, selector: &str) -> Result<()> {
        let selector = selector.to_string();
        self.with_page(|page| async move {
            let el = page
                .find_element(selector.as_str())
                .await
                .with_context(|| format!("no element matches '{selector}'"))?;
            el.click().await.context("click failed")?;
            Ok(())
        })
        .await
    }

    /// Type text into the element matching `selector`, optionally pressing Enter.
    pub async fn type_into(&self, selector: &str, text: &str, submit: bool) -> Result<()> {
        let selector = selector.to_string();
        let text = text.to_string();
        self.with_page(|page| async move {
            let el = page
                .find_element(selector.as_str())
                .await
                .with_context(|| format!("no element matches '{selector}'"))?;
            el.click().await.context("focus failed")?;
            el.type_str(&text).await.context("type failed")?;
            if submit {
                el.press_key("Enter").await.context("press Enter failed")?;
            }
            Ok(())
        })
        .await
    }

    /// Return the innerText of `selector` (or the whole body when omitted).
    pub async fn get_text(&self, selector: Option<&str>) -> Result<String> {
        let js = match selector {
            Some(sel) => format!(
                "(() => {{ const e = document.querySelector({sel}); return e ? (e.innerText || '') : ''; }})()",
                sel = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
            ),
            None => "document.body ? document.body.innerText : ''".to_string(),
        };
        Ok(self.eval(&js).await?.as_str().unwrap_or("").to_string())
    }

    /// The page's current URL.
    pub async fn current_url(&self) -> Result<String> {
        self.with_page(|page| async move { current_url(&page).await }).await
    }

    /// Whether a Chromium session is currently live.
    pub async fn is_open(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Close the browser and tear down the handler task.
    pub async fn close(&self) -> Result<()> {
        let live = self.inner.lock().await.take();
        if let Some(mut live) = live {
            let _ = live.browser.close().await;
            live.handler_task.abort();
        }
        Ok(())
    }
}

async fn current_url(page: &Page) -> Result<String> {
    let res = page.evaluate("window.location.href").await;
    match res {
        Ok(v) => Ok(v.into_value().unwrap_or_default()),
        Err(_) => Ok(String::new()),
    }
}

/// Prepend `https://` when the user typed a bare host, and pass through
/// `about:` / `file:` / explicit schemes untouched.
fn normalise_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "about:blank".to_string();
    }
    if trimmed.contains("://") || trimmed.starts_with("about:") {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}
