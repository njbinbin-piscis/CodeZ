//! CodeZ desktop host — Tauri application entry point.
//!
//! Bridges the React frontend (IDE / Agent modes) to native capabilities and,
//! in later milestones, to the shared `piscis-engine` agent kernel. M0 wires
//! the IDE workspace: file I/O, git, search, a PTY terminal, a filesystem
//! watcher, and the LSP ↔ WebSocket bridge.

pub mod commands;
pub mod context_assembly;
pub mod journal;
pub mod lsp;
pub mod state;
pub mod tools;

use state::AppState;
use tauri::Manager;

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
        .setup(|app| {
            // Explicitly apply the bundled icon — some Linux WMs skip it in dev otherwise.
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
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
            commands::ide::ide_git_discard,
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
            commands::ide::ide_terminal_count,
            commands::ide::ide_terminal_destroy_all,
            commands::ide::ide_terminal_is_alive,
            // file-change watcher
            commands::ide::ide_start_watcher,
            commands::ide::ide_stop_watcher,
            // LSP bridge
            commands::ide::ide_lsp_list_languages,
            commands::ide::ide_lsp_start,
            commands::ide::ide_lsp_stop,
            // platform
            commands::platform::open_path,
            // AI chat (agent turn on the piscis-engine kernel)
            commands::chat::chat_send,
            commands::chat::chat_cancel,
            // Cmd-K inline edit + Tab completion (ghost text)
            commands::edit::inline_edit,
            commands::edit::ai_inline_completion,
            // Codebase index + semantic-ish search (M5)
            commands::codebase::codebase_index_build,
            commands::codebase::codebase_search,
            // Isolated Agent tasks: worktree + diff review + merge/PR (M4)
            commands::agent_task::agent_task_create,
            commands::agent_task::agent_task_list,
            commands::agent_task::agent_task_changed_files,
            commands::agent_task::agent_task_file_diff,
            commands::agent_task::agent_task_merge,
            commands::agent_task::agent_task_discard,
            commands::agent_task::agent_task_open_pr,
            // Repo Wiki — module/architecture overview from the index (M8)
            commands::repo_wiki::repo_wiki_generate,
            // VS Code .vsix contribution-point ingestion
            commands::vsix::import_vsix,
            // chat session management
            commands::session::chat_list_sessions,
            commands::session::chat_get_messages,
            commands::session::chat_fork_session,
            commands::session::chat_restore_checkpoint,
            commands::session::chat_delete_session,
            // LLM / kernel settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::is_configured,
            // ClawHub skill marketplace
            commands::clawhub::clawhub_search,
            commands::clawhub::clawhub_install,
            // File journal — Review / Undo of a turn's edits
            commands::journal::journal_list_changes,
            commands::journal::journal_undo_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CodeZ desktop application");
}
