//! Headless Chromium driver (CDP via `chromiumoxide`).
//!
//! AgentZ embeds a real Chromium instance driven over the Chrome DevTools
//! Protocol — the same approach Cursor/Playwright use. The browser runs
//! headless; its frames are streamed into the IDE's Browser panel as PNG
//! screenshots, and pointer events from the panel are forwarded back. The
//! shared [`BrowserManager`] is also handed to the agent's `browser` tool so
//! automation (navigate / click / type / eval / screenshot) drives the exact
//! same page the user sees.
//!
//! One page/tab is kept live at a time. Launch is lazy: the first navigate (or
//! the panel opening) spawns Chromium; [`BrowserManager::close`] tears it down.

use std::path::{Path, PathBuf};
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

/// A picked / inspected DOM element returned to the frontend / agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PickedElement {
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub class_name: String,
    #[serde(default)]
    pub rect_x: f64,
    #[serde(default)]
    pub rect_y: f64,
    #[serde(default)]
    pub rect_width: f64,
    #[serde(default)]
    pub rect_height: f64,
    #[serde(default)]
    pub dom_path: String,
    #[serde(default)]
    pub react_component: String,
}

struct Live {
    browser: Browser,
    page: Page,
    handler_task: JoinHandle<()>,
}

/// Cloneable handle to the single live Chromium session. Stored in `AppState`
/// and shared with the agent `browser` tool.
#[derive(Clone)]
pub struct BrowserManager {
    inner: Arc<Mutex<Option<Live>>>,
    viewport: Arc<Mutex<(u32, u32)>>,
    /// Per-session profile dir (chromiumoxide defaults to a fixed `/tmp/chromiumoxide-runner`
    /// which breaks when a prior instance did not shut down cleanly).
    profile_dir: Arc<Mutex<PathBuf>>,
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            viewport: Arc::new(Mutex::new((1280, 800))),
            profile_dir: Arc::new(Mutex::new(fresh_profile_dir())),
        }
    }
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
        let (vw, vh) = *self.viewport.lock().await;
        let chrome = resolve_chrome_executable().context(
            "Chrome/Chromium not found — install Google Chrome or set CODEZ_CHROME to the executable path",
        )?;

        let mut last_err: Option<anyhow::Error> = None;
        for attempt in 0..2 {
            let profile = self.profile_dir.lock().await.clone();
            // Drop stale SingletonLock from a crashed prior attempt on this profile.
            let _ = tokio::fs::remove_dir_all(&profile).await;

            let mut config_builder = BrowserConfig::builder()
                .chrome_executable(&chrome)
                .user_data_dir(&profile)
                .window_size(vw, vh)
                .no_sandbox()
                .arg("--disable-gpu")
                .arg("--disable-dev-shm-usage");
            if attempt == 0 {
                config_builder = config_builder.new_headless_mode();
            }
            let config = config_builder
                .build()
                .map_err(|e| anyhow!("browser config: {e}"))?;

            let launch = Browser::launch(config).await;
            let (mut browser, mut handler) = match launch {
                Ok(pair) => pair,
                Err(e) => {
                    last_err = Some(anyhow::Error::new(e).context(format!(
                        "failed to launch Chromium at {} (profile: {}, attempt {})",
                        chrome.display(),
                        profile.display(),
                        attempt + 1
                    )));
                    *self.profile_dir.lock().await = fresh_profile_dir();
                    continue;
                }
            };

            let handler_task = tokio::spawn(async move {
                while let Some(h) = handler.next().await {
                    if h.is_err() {
                        break;
                    }
                }
            });

            match browser.new_page("about:blank").await {
                Ok(page) => {
                    *guard = Some(Live {
                        browser,
                        page,
                        handler_task,
                    });
                    return Ok(());
                }
                Err(e) => {
                    let _ = browser.close().await;
                    handler_task.abort();
                    last_err = Some(
                        anyhow::Error::new(e)
                            .context("failed to open initial page after Chromium launch"),
                    );
                    *self.profile_dir.lock().await = fresh_profile_dir();
                }
            }
        }

        Err(last_err.unwrap_or_else(|| {
            anyhow!("failed to launch Chromium at {}", chrome.display())
        }))
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

    /// Resize the Chromium viewport to match the IDE browser panel (CSS pixels).
    /// Keeps screenshot coordinates 1:1 with the panel for accurate clicks/picks.
    pub async fn set_viewport(&self, width: u32, height: u32) -> Result<(u32, u32)> {
        use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;

        let w = width.clamp(320, 3840);
        let h = height.clamp(200, 2160);
        *self.viewport.lock().await = (w, h);
        self.with_page(|page| async move {
            page.execute(SetDeviceMetricsOverrideParams::new(
                w as i64,
                h as i64,
                1.0,
                false,
            ))
            .await
            .context("set viewport failed")?;
            Ok(())
        })
        .await?;
        Ok((w, h))
    }

    /// Current viewport size (width, height) in CSS pixels.
    pub async fn viewport_size(&self) -> (u32, u32) {
        *self.viewport.lock().await
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

    /// Identify the element at viewport coordinates (x, y) for pick / inspect.
    pub async fn pick_at(&self, x: f64, y: f64) -> Result<Option<PickedElement>> {
        let js = element_at_point_js(x, y);
        let val = self.eval(&js).await?;
        if val.is_null() {
            return Ok(None);
        }
        Ok(serde_json::from_value(val).ok())
    }

    /// Alias for [`Self::pick_at`] — used for hover-highlight in the panel.
    pub async fn inspect_at(&self, x: f64, y: f64) -> Result<Option<PickedElement>> {
        self.pick_at(x, y).await
    }

    /// Resolve a CSS selector against the live page (for chat `@browser-element` expansion).
    pub async fn query_selector(&self, selector: &str) -> Result<Option<PickedElement>> {
        let sel = serde_json::to_string(selector).context("encode selector")?;
        let js = element_info_js(&format!("document.querySelector({sel})"));
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
        let profile = self.profile_dir.lock().await.clone();
        if let Some(mut live) = live {
            let _ = live.browser.close().await;
            live.handler_task.abort();
        }
        let _ = tokio::fs::remove_dir_all(&profile).await;
        *self.profile_dir.lock().await = fresh_profile_dir();
        Ok(())
    }
}

fn fresh_profile_dir() -> PathBuf {
    std::env::temp_dir().join(format!("agentz-browser-{}", uuid::Uuid::new_v4()))
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
fn element_at_point_js(x: f64, y: f64) -> String {
    element_info_js(&format!("document.elementFromPoint({x}, {y})"))
}

fn element_info_js(el_expr: &str) -> String {
    format!(
        r#"(() => {{
            const el = {el_expr};
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
            const domPath = (node) => {{
                const parts = [];
                let cur = node;
                while (cur && cur.nodeType === 1) {{
                    let seg = cur.tagName.toLowerCase();
                    if (cur.id) seg += '#' + CSS.escape(cur.id);
                    else if (cur.classList && cur.classList.length) {{
                        seg += '.' + Array.from(cur.classList).slice(0, 3).map(c => CSS.escape(c)).join('.');
                    }}
                    const parent = cur.parentElement;
                    if (parent && parent.children.length > 1) {{
                        const idx = Array.from(parent.children).indexOf(cur) + 1;
                        seg += `:nth-child(${{idx}})`;
                    }}
                    parts.unshift(seg);
                    if (cur.id === 'root' || cur === document.body || cur === document.documentElement) break;
                    cur = cur.parentElement;
                }}
                return parts.join(' > ');
            }};
            const reactComponent = (node) => {{
                const fiberKey = Object.keys(node).find(k =>
                    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
                );
                let fiber = fiberKey ? node[fiberKey] : null;
                while (fiber) {{
                    const t = fiber.type;
                    if (t) {{
                        if (typeof t === 'string') {{
                            fiber = fiber.return;
                            continue;
                        }}
                        const name = t.displayName || t.name;
                        if (name) return name;
                    }}
                    fiber = fiber.return;
                }}
                return '';
            }};
            const r = el.getBoundingClientRect();
            return {{
                selector: sel(el),
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                class_name: typeof el.className === 'string' ? el.className : '',
                text: (el.innerText || el.value || '').slice(0, 300),
                html: el.outerHTML.slice(0, 800),
                rect_x: r.x,
                rect_y: r.y,
                rect_width: r.width,
                rect_height: r.height,
                dom_path: domPath(el),
                react_component: reactComponent(el)
            }};
        }})()"#
    )
}

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

/// Resolve a Chrome/Chromium binary. GUI apps often have a minimal `PATH`, so we
/// probe well-known locations before falling back to chromiumoxide detection.
fn resolve_chrome_executable() -> Result<PathBuf> {
    for key in ["CODEZ_CHROME", "CHROME", "GOOGLE_CHROME_BIN"] {
        if let Ok(raw) = std::env::var(key) {
            if let Some(path) = normalize_chrome_path(Path::new(raw.trim())) {
                return Ok(path);
            }
        }
    }

    for candidate in chrome_executable_candidates() {
        if let Some(path) = normalize_chrome_path(Path::new(candidate)) {
            return Ok(path);
        }
    }

    if let Ok(path) = chromiumoxide::detection::default_executable(
        chromiumoxide::detection::DetectionOptions::default(),
    ) {
        if let Some(exe) = normalize_chrome_path(&path) {
            return Ok(exe);
        }
    }

    Err(anyhow!(
        "no Chrome/Chromium executable found (tried common install paths and PATH)"
    ))
}

fn chrome_executable_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "linux")]
    {
        &[
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/google-chrome",
            "/snap/bin/chromium",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ]
    }
    #[cfg(target_os = "macos")]
    {
        &[
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    }
    #[cfg(target_os = "windows")]
    {
        &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        &[] as &[&str]
    }
}

/// Accept a file path or a directory (chromiumoxide on Linux returns `/opt/google/chrome`).
fn normalize_chrome_path(path: &Path) -> Option<PathBuf> {
    if chrome_path_is_executable(path) {
        return Some(path.to_path_buf());
    }
    if path.is_dir() {
        for name in ["google-chrome", "chrome", "chromium", "chromium-browser"] {
            let candidate = path.join(name);
            if chrome_path_is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn launch_with_unique_profile() {
        let mgr = BrowserManager::new();
        mgr.set_viewport(800, 600).await.unwrap();
        mgr.ensure_launch_for_test().await.expect("browser should launch");
        assert!(mgr.is_open().await);
        mgr.close().await.unwrap();
        assert!(!mgr.is_open().await);
    }
}

impl BrowserManager {
    #[cfg(test)]
    async fn ensure_launch_for_test(&self) -> Result<()> {
        self.ensure().await
    }
}

fn chrome_path_is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
