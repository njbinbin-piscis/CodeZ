//! VS Code extension host sidecar broker.
//!
//! Launches the Node-based extension host (`extension-host/dist/host.js`) as a
//! child process and brokers its line-delimited-JSON RPC over a Tauri event
//! channel: stdout lines are emitted to the renderer (which runs the MainThread
//! side of the protocol), and the renderer sends RPC frames back via
//! [`ext_host_send`], which writes them to the child's stdin.

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use serde_json::json;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::state::AppState;

/// Tauri event channel that carries extension-host RPC frames + logs to the UI.
pub const EXT_HOST_EVENT: &str = "agentz:ext-host";

/// Shared lifecycle state for the (single) extension host process.
#[derive(Default)]
pub struct ExtHostManager {
    inner: Mutex<ExtHostInner>,
}

#[derive(Default)]
struct ExtHostInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    project_dir: Option<String>,
}

impl ExtHostManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Serialize)]
pub struct ExtHostStatus {
    pub running: bool,
    pub project_dir: Option<String>,
    pub host_js: String,
}

/// Resolve the path to the bundled extension-host entry (`host.js`).
///
/// Precedence: explicit arg → `$CODEZ_EXT_HOST_JS` → Tauri resource bundle
/// (`extension-host/host.js` from `tauri.conf.json`) → dev build path → legacy
/// fallbacks relative to the executable / cwd.
fn resolve_host_js(app: &AppHandle, explicit: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!("extension host js not found: {}", pb.display()));
    }
    if let Ok(env_path) = std::env::var("CODEZ_EXT_HOST_JS") {
        let pb = PathBuf::from(env_path);
        if pb.exists() {
            return Ok(pb);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // Production bundle: tauri.conf.json maps dist/host.js → extension-host/host.js
    if let Ok(p) = app
        .path()
        .resolve("extension-host/host.js", BaseDirectory::Resource)
    {
        candidates.push(p.clone());
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev build: extension-host/dist/host.js next to the crate.
    let dev_host =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension-host/dist/host.js");
    candidates.push(dev_host.clone());
    if dev_host.exists() {
        return Ok(dev_host);
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(d) = &dir {
                candidates.push(d.join("extension-host/dist/host.js"));
                candidates.push(d.join("resources/extension-host/host.js"));
                candidates.push(d.join("extension-host/host.js"));
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("extension-host/dist/host.js"));
        candidates.push(cwd.join("../extension-host/dist/host.js"));
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "could not locate extension-host/dist/host.js (set CODEZ_EXT_HOST_JS). tried: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Node executable to launch the host with (overridable via `$CODEZ_NODE`).
fn node_bin() -> String {
    std::env::var("CODEZ_NODE").unwrap_or_else(|_| "node".to_string())
}

/// Start the extension host for a project. Idempotent: a second call restarts.
#[tauri::command]
pub async fn ext_host_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project_dir: String,
    host_js: Option<String>,
) -> Result<ExtHostStatus, String> {
    let host_js_path = resolve_host_js(&app, host_js)?;
    let mgr = state.ext_host.clone();

    // Tear down any prior instance first.
    {
        let mut inner = mgr.inner.lock().await;
        inner.stdin = None;
        inner.child = None;
    }

    let mut child = piscis_kernel::proc::tokio_command(node_bin())
        .arg(&host_js_path)
        .current_dir(&project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn extension host ({}): {}", node_bin(), e))?;

    let stdin = child.stdin.take().ok_or("failed to take host stdin")?;
    let stdout = child.stdout.take().ok_or("failed to take host stdout")?;
    let stderr = child.stderr.take();

    // stdout → renderer (RPC frames, one JSON object per line).
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = app_out.emit(EXT_HOST_EVENT, json!({ "channel": "message", "data": line }));
                }
                Ok(None) => {
                    let _ = app_out.emit(EXT_HOST_EVENT, json!({ "channel": "exit", "data": "stdout closed" }));
                    break;
                }
                Err(e) => {
                    warn!("ext-host stdout read error: {}", e);
                    break;
                }
            }
        }
    });

    // stderr → renderer log channel (host diagnostics + extension errors).
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_err.emit(EXT_HOST_EVENT, json!({ "channel": "log", "data": line }));
            }
        });
    }

    {
        let mut inner = mgr.inner.lock().await;
        inner.child = Some(child);
        inner.stdin = Some(stdin);
        inner.project_dir = Some(project_dir.clone());
    }

    info!("extension host started for {} ({})", project_dir, host_js_path.display());
    Ok(ExtHostStatus {
        running: true,
        project_dir: Some(project_dir),
        host_js: host_js_path.display().to_string(),
    })
}

/// Send one RPC frame (a single JSON line) to the extension host's stdin.
#[tauri::command]
pub async fn ext_host_send(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let mgr = state.ext_host.clone();
    let mut inner = mgr.inner.lock().await;
    let stdin = inner
        .stdin
        .as_mut()
        .ok_or("extension host is not running")?;
    let mut line = message;
    if !line.ends_with('\n') {
        line.push('\n');
    }
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to host stdin failed: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush host stdin failed: {e}"))?;
    Ok(())
}

/// Stop the extension host (kills the child via kill_on_drop).
#[tauri::command]
pub async fn ext_host_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state.ext_host.clone();
    let mut inner = mgr.inner.lock().await;
    inner.stdin = None;
    inner.child = None;
    inner.project_dir = None;
    info!("extension host stopped");
    Ok(())
}

/// Report whether the host is running.
#[tauri::command]
pub async fn ext_host_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ExtHostStatus, String> {
    let mgr = state.ext_host.clone();
    let inner = mgr.inner.lock().await;
    Ok(ExtHostStatus {
        running: inner.child.is_some(),
        project_dir: inner.project_dir.clone(),
        host_js: resolve_host_js(&app, None)
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    })
}
