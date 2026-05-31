//! CodeZ desktop host — Tauri application entry point.
//!
//! Bridges the React frontend (IDE / Agent modes) to native capabilities and,
//! in later milestones, to the shared `pisci-engine` agent kernel. M0 wires
//! the IDE workspace: file I/O, git, search, a PTY terminal, a filesystem
//! watcher, and the LSP ↔ WebSocket bridge.

pub mod commands;
pub mod lsp;
pub mod state;

use state::AppState;

/// Build and run the CodeZ desktop application.
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // file tree + I/O
            commands::ide::ide_list_files,
            commands::ide::ide_read_file,
            commands::ide::ide_write_file,
            commands::ide::ide_file_action,
            commands::ide::ide_search_files,
            // git
            commands::ide::ide_git_status,
            commands::ide::ide_git_diff,
            commands::ide::ide_git_branches,
            commands::ide::ide_git_file_at_ref,
            commands::ide::ide_git_add,
            commands::ide::ide_git_reset,
            commands::ide::ide_git_add_all,
            commands::ide::ide_git_reset_all,
            commands::ide::ide_git_commit,
            commands::ide::ide_git_checkout,
            commands::ide::ide_git_create_branch,
            // terminal (PTY)
            commands::ide::ide_terminal_create,
            commands::ide::ide_terminal_write,
            commands::ide::ide_terminal_resize,
            commands::ide::ide_terminal_destroy,
            // file-change watcher
            commands::ide::ide_start_watcher,
            commands::ide::ide_stop_watcher,
            // LSP bridge
            commands::ide::ide_lsp_list_languages,
            commands::ide::ide_lsp_start,
            commands::ide::ide_lsp_stop,
            // platform
            commands::platform::open_path,
            // AI chat (agent turn on the pisci-engine kernel)
            commands::chat::chat_send,
            // chat session management
            commands::session::chat_list_sessions,
            commands::session::chat_get_messages,
            commands::session::chat_fork_session,
            commands::session::chat_delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CodeZ desktop application");
}
