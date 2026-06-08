//! Small platform-integration commands shared across workspaces.

use std::io::Write;
use std::path::Path;

use tauri::AppHandle;

use super::data_scope::resolve_global_config_dir;

/// Reveal a path in the OS file manager (or open it with the default handler).
///
/// Mirrors the `openPath` IPC the frontend calls from the file-tree context
/// menu. Uses the platform's native opener so no extra plugin permission is
/// required.
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {path}"));
    }

    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    piscis_kernel::proc::tokio_command(program)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open '{path}': {e}"))?;
    Ok(())
}

/// Append a frontend composer-debug line to `{config_dir}/logs/composer.log`.
/// Survives UI freezes — read the file after force-quitting the app.
#[tauri::command]
pub async fn composer_debug_log(app: AppHandle, line: String) -> Result<(), String> {
    let log_dir = resolve_global_config_dir(&app)?.join("logs");
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("create log dir: {e}"))?;
        let path = log_dir.join("composer.log");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("open composer.log: {e}"))?;
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        writeln!(f, "{now} {line}").map_err(|e| format!("write composer.log: {e}"))
    })
    .await
    .map_err(|e| format!("composer log task: {e}"))?
}
