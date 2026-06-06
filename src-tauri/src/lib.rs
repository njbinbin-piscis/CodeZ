#![recursion_limit = "512"]
//! AgentZ desktop host — Tauri application entry point.
//!
//! Bridges the React frontend (IDE / Agent modes) to native capabilities and,
//! in later milestones, to the shared `piscis-engine` agent kernel. M0 wires
//! the IDE workspace: file I/O, git, search, a PTY terminal, a filesystem
//! watcher, and the LSP ↔ WebSocket bridge.

pub mod browser;
pub mod commands;
pub mod context_assembly;
pub mod gateway;
pub mod journal;
pub mod lsp;
pub mod runtime;
pub mod state;
pub mod tools;

use state::AppState;
use tauri::Manager;

/// Build and run the AgentZ desktop application.
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
            // Phase 5: install built-in agent/team packs on first run.
            commands::seed::seed_builtin_packs(app.handle());
            // Phase 0A: drive headless agent turns for inbound IM messages.
            commands::gateway::spawn_inbound_consumer(app.handle().clone());
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
            commands::ide::ide_terminal_read,
            commands::ide::terminal_snippet_put,
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
            // Embedded browser panel (CDP via chromiumoxide)
            commands::browser::browser_navigate,
            commands::browser::browser_screenshot,
            commands::browser::browser_click_at,
            commands::browser::browser_pick_at,
            commands::browser::browser_inspect_at,
            commands::browser::browser_set_viewport,
            commands::browser::browser_current_url,
            commands::browser::browser_is_open,
            commands::browser::browser_close,
            // Repo Wiki — module/architecture overview from the index (M8)
            commands::repo_wiki::repo_wiki_generate,
            // VS Code .vsix contribution-point ingestion
            commands::vsix::import_vsix,
            // VS Code extension ecosystem: install/manage + extension host sidecar
            commands::vsix::vsix_install,
            commands::vsix::vsix_install_from_url,
            commands::vsix::vsix_list,
            commands::vsix::vsix_uninstall,
            commands::vsix::vsix_set_enabled,
            commands::vsix::vsix_extensions_dir,
            commands::ext_host::ext_host_start,
            commands::ext_host::ext_host_send,
            commands::ext_host::ext_host_stop,
            commands::ext_host::ext_host_status,
            // Debug Adapter Protocol broker
            commands::dap::dap_start,
            commands::dap::dap_send,
            commands::dap::dap_stop,
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
            // IM gateway "assistants" (Phase 0A): Feishu / WeCom / DingTalk / WeChat …
            commands::gateway::get_im_settings,
            commands::gateway::save_im_settings,
            commands::gateway::list_gateway_channels,
            commands::gateway::connect_gateway_channels,
            commands::gateway::disconnect_gateway_channels,
            commands::gateway::start_wechat_login,
            commands::gateway::poll_wechat_login,
            // Connectors (Phase 0B): authenticated external services exposed as MCP tools
            commands::connectors::connectors_list,
            commands::connectors::connectors_install,
            commands::connectors::connectors_uninstall,
            commands::connectors::connectors_set_enabled,
            commands::connectors::connectors_save_credentials,
            commands::connectors::connectors_get_credentials,
            // Agents (Phase 2): installable single-Koi personas + kois sync
            commands::agents::agents_list,
            commands::agents::agents_get,
            commands::agents::agents_save,
            commands::agents::agents_install,
            commands::agents::agents_uninstall,
            commands::agents::agents_sync,
            // Teams (Phase 3): installable Pool templates + pool creation
            commands::teams::teams_list,
            commands::teams::teams_get,
            commands::teams::teams_save,
            commands::teams::teams_install,
            commands::teams::teams_uninstall,
            commands::teams::teams_create_pool,
            // Workflow teams (no-coordinator deterministic graph)
            commands::workflow::workflow_start,
            commands::workflow::workflow_get_run,
            commands::workflow::workflow_list_runs,
            commands::workflow::workflow_cancel,
            commands::workflow::workflow_resume_human,
            // Pool (Phase 3): team collaboration board reads + lifecycle
            commands::pool::pool_list,
            commands::pool::pool_get,
            commands::pool::pool_members,
            commands::pool::pool_messages,
            commands::pool::pool_todos,
            commands::pool::pool_kois,
            commands::pool::pool_set_status,
            commands::pool::pool_delete,
            // Marketplace (Phase 4): unified multi-source discovery + install
            commands::marketplace::marketplace_search,
            commands::marketplace::marketplace_install,
            commands::marketplace::marketplace_uninstall,
            // User tools (executable plugin manifests in {config}/user-tools)
            commands::user_tools::user_tools_list,
            commands::user_tools::user_tools_install,
            commands::user_tools::user_tools_uninstall,
            commands::user_tools::user_tools_save_config,
            commands::user_tools::user_tools_get_config,
            // Workbench management: installed skills, project rules, hooks
            commands::workbench::skills_list_installed,
            commands::workbench::skills_uninstall,
            commands::workbench::rules_list,
            commands::workbench::rules_read,
            commands::workbench::rules_write,
            commands::workbench::rules_delete,
            commands::workbench::rules_set_enabled,
            commands::workbench::hooks_get,
            commands::workbench::hooks_save,
            commands::workbench::hooks_run,
            // Interactive UI (chat_ui tool)
            commands::interactive::respond_interactive_ui,
            // File journal — Review / Undo of a turn's edits
            commands::journal::journal_list_changes,
            commands::journal::journal_undo_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the AgentZ desktop application");
}
