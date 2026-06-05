//! Debug Adapter Protocol (DAP) broker.
//!
//! Launches a debug adapter process and brokers its `Content-Length`-framed
//! DAP messages over a Tauri event channel, mirroring [`ext_host`]. The
//! renderer's `dapClient` speaks DAP on top: stdout DAP messages are emitted on
//! `codez:dap`, and the renderer sends requests via [`dap_send`].

use std::process::Stdio;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::state::AppState;

/// Tauri event channel carrying DAP messages + logs to the renderer.
pub const DAP_EVENT: &str = "codez:dap";

#[derive(Default)]
pub struct DapManager {
    inner: Mutex<DapInner>,
}

#[derive(Default)]
struct DapInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

impl DapManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Serialize)]
pub struct DapStatus {
    pub running: bool,
}

/// Start a debug adapter. `command`+`args` name the adapter executable (e.g.
/// `node`, `["/path/to/dapServer.js"]`). Many adapters ship with extensions.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<DapStatus, String> {
    let mgr = state.dap.clone();
    {
        let mut inner = mgr.inner.lock().await;
        inner.stdin = None;
        inner.child = None;
    }

    let mut cmd = piscis_kernel::proc::tokio_command(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn debug adapter '{command}': {e}"))?;

    let stdin = child.stdin.take().ok_or("failed to take adapter stdin")?;
    let stdout = child.stdout.take().ok_or("failed to take adapter stdout")?;
    let stderr = child.stderr.take();

    // stdout → renderer: parse Content-Length frames, emit each DAP message.
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut reader = stdout;
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => {
                    let _ = app_out.emit(DAP_EVENT, json!({ "channel": "exit", "data": "adapter stdout closed" }));
                    break;
                }
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    drain_frames(&mut buf, &app_out);
                }
                Err(e) => {
                    warn!("DAP stdout read error: {}", e);
                    break;
                }
            }
        }
    });

    if let Some(mut stderr) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&chunk[..n]).to_string();
                        let _ = app_err.emit(DAP_EVENT, json!({ "channel": "log", "data": text }));
                    }
                }
            }
        });
    }

    {
        let mut inner = mgr.inner.lock().await;
        inner.child = Some(child);
        inner.stdin = Some(stdin);
    }
    info!("debug adapter started: {} {:?}", command, args);
    Ok(DapStatus { running: true })
}

/// Send one DAP message (a JSON object) to the adapter, adding the
/// `Content-Length` header.
#[tauri::command]
pub async fn dap_send(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let mgr = state.dap.clone();
    let mut inner = mgr.inner.lock().await;
    let stdin = inner.stdin.as_mut().ok_or("debug adapter is not running")?;
    let header = format!("Content-Length: {}\r\n\r\n", message.as_bytes().len());
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("dap write header: {e}"))?;
    stdin
        .write_all(message.as_bytes())
        .await
        .map_err(|e| format!("dap write body: {e}"))?;
    stdin.flush().await.map_err(|e| format!("dap flush: {e}"))?;
    Ok(())
}

/// Stop the debug adapter.
#[tauri::command]
pub async fn dap_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state.dap.clone();
    let mut inner = mgr.inner.lock().await;
    inner.stdin = None;
    inner.child = None;
    Ok(())
}

/// Pull complete `Content-Length` frames out of the accumulation buffer and
/// emit each message body to the renderer.
fn drain_frames(buf: &mut Vec<u8>, app: &AppHandle) {
    loop {
        let Some(header_end) = find_subsequence(buf, b"\r\n\r\n") else {
            return;
        };
        let header = String::from_utf8_lossy(&buf[..header_end]);
        let content_len = header
            .lines()
            .find_map(|l| {
                let l = l.trim();
                l.strip_prefix("Content-Length:")
                    .or_else(|| l.strip_prefix("Content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        let body_start = header_end + 4;
        if buf.len() < body_start + content_len {
            return; // wait for more bytes
        }
        let body = buf[body_start..body_start + content_len].to_vec();
        buf.drain(..body_start + content_len);
        if let Ok(text) = String::from_utf8(body) {
            let _ = app.emit(DAP_EVENT, json!({ "channel": "message", "data": text }));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
