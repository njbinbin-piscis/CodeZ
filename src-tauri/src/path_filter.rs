//! Unified path ignore rules for the file watcher, file tree, and codebase index.
//!
//! Single source of truth so internal SQLite files (`.agentz/*.db`), build
//! artifacts, and dependency trees do not trigger `ide-file-changed` storms.

/// Directory names skipped during tree walks and when they appear as path segments.
pub const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".koi-worktrees",
    ".agentz-worktrees",
    "target",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".venv",
    "venv",
    ".DS_Store",
    ".agentz",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
    ".qoder",
];

/// File suffixes that should never surface as user-source changes.
const IGNORED_FILE_SUFFIXES: &[&str] = &[
    ".db",
    ".db-wal",
    ".db-shm",
    ".db-journal",
    ".sqlite",
    ".sqlite3",
    ".swp",
    ".tmp",
];

/// Normalize a project-relative path to forward slashes.
pub fn normalize_rel_path(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// Whether a directory entry name should be skipped when building a file tree or index walk.
pub fn is_ignored_dir_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.contains(&name) || name.starts_with('.')
}

/// Whether a relative path (normalized `/`) should be ignored by the filesystem watcher.
pub fn should_watch_path(rel_norm: &str) -> bool {
    !is_ignored_rel_path(rel_norm)
}

/// Whether a relative path is eligible for incremental codebase indexing.
pub fn should_index_path(rel_norm: &str) -> bool {
    should_watch_path(rel_norm)
}

/// Core ignore check for watcher / index side-effects.
pub fn is_ignored_rel_path(rel_norm: &str) -> bool {
    let rel = rel_norm.trim_start_matches("./");
    if rel.is_empty() || rel == "." {
        return true;
    }

    let basename = rel.rsplit('/').next().unwrap_or(rel);
    for suffix in IGNORED_FILE_SUFFIXES {
        if basename.ends_with(suffix) {
            return true;
        }
    }
    if basename.ends_with('~') {
        return true;
    }

    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return true;
    }

    // Interior directory segments (everything before the file name).
    for seg in &segments[..segments.len().saturating_sub(1)] {
        if IGNORED_DIR_NAMES.contains(seg) || seg.starts_with('.') {
            return true;
        }
    }

    // Root-level single segment that is a known junk/artifact name.
    if segments.len() == 1 && IGNORED_DIR_NAMES.contains(&segments[0]) {
        return true;
    }

    false
}

/// File-tree helper: combine built-in dir ignores with optional `.gitignore` patterns.
pub fn is_ignored_tree_entry(name: &str, rel_path: &str, gitignore_patterns: &[String]) -> bool {
    if IGNORED_DIR_NAMES.contains(&name) {
        return true;
    }
    for pattern in gitignore_patterns {
        let p = pattern.trim_start_matches('/');
        if name == p || rel_path.contains(p) {
            return true;
        }
        if p.ends_with('/') && name == p.trim_end_matches('/') {
            return true;
        }
        if p.starts_with('*') {
            let ext = p.trim_start_matches('*');
            if name.ends_with(ext) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_agentz_sqlite_and_wal() {
        assert!(is_ignored_rel_path(".agentz/piscis.db"));
        assert!(is_ignored_rel_path(".agentz/journal.db"));
        assert!(is_ignored_rel_path(".agentz/index.db"));
        assert!(is_ignored_rel_path(".agentz/piscis.db-wal"));
        assert!(is_ignored_rel_path(".agentz/piscis.db-shm"));
        assert!(!should_watch_path(".agentz/piscis.db"));
    }

    #[test]
    fn allows_user_source_files() {
        assert!(!is_ignored_rel_path("src/main.rs"));
        assert!(!is_ignored_rel_path("lib/utils.ts"));
        assert!(should_watch_path("src/main.rs"));
    }

    #[test]
    fn allows_root_dotfiles_users_edit() {
        assert!(!is_ignored_rel_path(".gitignore"));
        assert!(!is_ignored_rel_path(".env"));
        assert!(should_watch_path(".gitignore"));
    }

    #[test]
    fn ignores_node_modules_at_any_depth() {
        assert!(is_ignored_rel_path("node_modules/pkg/index.js"));
        assert!(is_ignored_rel_path("packages/app/node_modules/foo/bar.js"));
    }

    #[test]
    fn ignores_build_artifacts() {
        assert!(is_ignored_rel_path("target/debug/agentz"));
        assert!(is_ignored_rel_path("dist/bundle.js"));
        assert!(is_ignored_rel_path("build/output.o"));
    }

    #[test]
    fn ignores_dot_directories_in_path() {
        assert!(is_ignored_rel_path(".github/workflows/ci.yml"));
        assert!(is_ignored_rel_path(".vscode/settings.json"));
    }

    #[test]
    fn ignores_coarse_agent_emit_path() {
        assert!(is_ignored_rel_path("."));
    }

    #[test]
    fn dir_name_matches_codebase_rules() {
        assert!(is_ignored_dir_name(".agentz"));
        assert!(is_ignored_dir_name("node_modules"));
        assert!(is_ignored_dir_name(".hidden"));
        assert!(!is_ignored_dir_name("src"));
    }
}
