//! IDE-coupled agent tools (LSP diagnostics, codebase search, etc.).

pub mod api_connector;
pub mod app_control;
pub mod browser;
pub mod call_fish;
pub mod chat_ui;
pub mod chat_ui_listen;
pub mod chat_ui_patch;
pub mod chat_ui_schema;
pub mod codebase_search;
pub mod delegate;
pub mod lsp;
pub mod read_lints;
pub mod terminal_read;
pub mod web_fetch;
