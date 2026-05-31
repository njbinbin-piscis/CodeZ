//! Small platform-integration commands shared across workspaces.

use std::path::Path;

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

    pisci_kernel::proc::tokio_command(program)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open '{path}': {e}"))?;
    Ok(())
}
