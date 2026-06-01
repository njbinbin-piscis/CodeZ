//! CodeZ file-journal shim.
//!
//! The journal *implementation* (pre-edit snapshots, Undo/replay, the
//! `AgentHooks` wiring) lives in the shared kernel
//! ([`pisci_kernel::agent::file_journal`]) so CodeZ and openpisci use the exact
//! same design. CodeZ adds only its storage-location convention
//! (`{project}/.codez/journal.db`) on top.

use std::path::PathBuf;

pub use pisci_kernel::agent::file_journal::{FileJournal, JournalChange};

/// Open the project-scoped journal at `{project}/.codez/journal.db`.
pub fn open_project_journal(project_dir: &str) -> Result<FileJournal, String> {
    let root = PathBuf::from(project_dir);
    let db_path = root.join(".codez").join("journal.db");
    FileJournal::open(&root, &db_path).map_err(|e| e.to_string())
}
