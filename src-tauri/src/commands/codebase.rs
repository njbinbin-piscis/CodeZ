//! Codebase semantic-ish index (M5).
//!
//! Chunks workspace source files into line windows, stores them in
//! `{project}/.agentz/index.db`, and answers `codebase_search` queries with a
//! keyword/term-frequency ranking (plus a path-name boost). This gives the
//! `@codebase` mention and the `codebase_search` agent tool real
//! whole-repo recall without requiring an embedding-model API key. The schema
//! is intentionally simple so an embedding column can be layered on later
//! (reusing `piscis_kernel::memory::vector`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::commands::data_scope::require_project_dir;

/// One ranked search hit returned to callers.
#[derive(Debug, Clone, Serialize)]
pub struct CodeSearchHit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub snippet: String,
    pub score: f64,
}

const CHUNK_LINES: usize = 50;
const MAX_FILE_BYTES: u64 = 1_000_000;

const ALWAYS_IGNORE: &[&str] = &[
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
];

const CODE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "c", "h", "cpp", "cc", "cxx",
    "hpp", "cs", "rb", "php", "swift", "kt", "scala", "lua", "sh", "bash", "json", "toml", "yaml",
    "yml", "md", "txt", "css", "scss", "html", "vue", "sql",
];

fn index_db_path(root: &Path) -> PathBuf {
    root.join(".agentz").join("index.db")
}

fn open_index(root: &Path) -> Result<Connection, String> {
    let dir = root.join(".agentz");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .agentz failed: {e}"))?;
    let conn = Connection::open(index_db_path(root)).map_err(|e| format!("open index db: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            content TEXT NOT NULL,
            lower TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);",
    )
    .map_err(|e| format!("create schema: {e}"))?;
    Ok(conn)
}

fn is_ignored_dir(name: &str) -> bool {
    ALWAYS_IGNORE.contains(&name) || name.starts_with('.')
}

fn is_code_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => CODE_EXTS.contains(&ext.to_lowercase().as_str()),
        None => false,
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if is_ignored_dir(&name) {
                continue;
            }
            collect_files(&path, out, depth + 1);
        } else if meta.is_file() && meta.len() <= MAX_FILE_BYTES && is_code_file(&path) {
            out.push(path);
        }
    }
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// (Re)build the whole index for `root`. Returns the chunk count.
pub fn build_index(root: &Path) -> Result<usize, String> {
    let conn = open_index(root)?;
    conn.execute("DELETE FROM chunks", [])
        .map_err(|e| format!("clear chunks: {e}"))?;

    let mut files = Vec::new();
    collect_files(root, &mut files, 0);

    let mut count = 0usize;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for file in &files {
        let Ok(raw) = std::fs::read(file) else {
            continue;
        };
        if raw[..raw.len().min(8192)].contains(&0) {
            continue; // binary
        }
        let content = String::from_utf8_lossy(&raw);
        let rel = rel_path(root, file);
        let lines: Vec<&str> = content.lines().collect();
        let mut start = 0usize;
        while start < lines.len() {
            let end = (start + CHUNK_LINES).min(lines.len());
            let chunk = lines[start..end].join("\n");
            if !chunk.trim().is_empty() {
                tx.execute(
                    "INSERT INTO chunks (path, start_line, end_line, content, lower)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![rel, start + 1, end, chunk, chunk.to_lowercase()],
                )
                .map_err(|e| format!("insert chunk: {e}"))?;
                count += 1;
            }
            start = end;
        }
    }
    tx.commit().map_err(|e| format!("commit index: {e}"))?;
    Ok(count)
}

/// Re-index a single file (incremental update from the watcher).
pub fn index_file(root: &Path, rel: &str) -> Result<(), String> {
    let conn = open_index(root)?;
    conn.execute("DELETE FROM chunks WHERE path = ?1", params![rel])
        .map_err(|e| format!("delete old chunks: {e}"))?;

    let full = root.join(rel);
    let Ok(raw) = std::fs::read(&full) else {
        return Ok(()); // deleted — nothing to add
    };
    if raw.len() as u64 > MAX_FILE_BYTES || raw[..raw.len().min(8192)].contains(&0) {
        return Ok(());
    }
    if !is_code_file(&full) {
        return Ok(());
    }
    let content = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = content.lines().collect();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + CHUNK_LINES).min(lines.len());
        let chunk = lines[start..end].join("\n");
        if !chunk.trim().is_empty() {
            conn.execute(
                "INSERT INTO chunks (path, start_line, end_line, content, lower)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![rel, start + 1, end, chunk, chunk.to_lowercase()],
            )
            .map_err(|e| format!("insert chunk: {e}"))?;
        }
        start = end;
    }
    Ok(())
}

fn tokenize(q: &str) -> Vec<String> {
    q.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| t.len() >= 2)
        .map(|t| t.to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        count += 1;
        from += pos + needle.len();
    }
    count
}

/// Search the index for `query`, building it lazily if empty. Returns the
/// top `limit` chunks ranked by term frequency + path-name boost.
pub fn search_index(root: &Path, query: &str, limit: usize) -> Result<Vec<CodeSearchHit>, String> {
    let terms = tokenize(query);
    if terms.is_empty() {
        return Ok(vec![]);
    }

    let mut conn = open_index(root)?;
    let empty: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    if empty == 0 {
        build_index(root)?;
        conn = open_index(root)?;
    }

    let mut stmt = conn
        .prepare("SELECT path, start_line, end_line, content, lower FROM chunks")
        .map_err(|e| format!("prepare search: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("query search: {e}"))?;

    let mut hits: Vec<CodeSearchHit> = Vec::new();
    for row in rows.flatten() {
        let (path, start_line, end_line, content, lower) = row;
        let path_lower = path.to_lowercase();
        let mut score = 0.0f64;
        let mut matched_terms = 0;
        for term in &terms {
            let c = count_occurrences(&lower, term);
            if c > 0 {
                matched_terms += 1;
                score += c as f64;
            }
            if path_lower.contains(term) {
                score += 3.0; // path-name relevance boost
            }
        }
        if matched_terms == 0 {
            continue;
        }
        // Reward chunks that hit more distinct query terms.
        score *= 1.0 + matched_terms as f64;
        let snippet: String = content.lines().take(12).collect::<Vec<_>>().join("\n");
        hits.push(CodeSearchHit {
            path,
            start_line: start_line as usize,
            end_line: end_line as usize,
            snippet,
            score,
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit.clamp(1, 50));
    Ok(hits)
}

// ─── Tauri commands ──────────────────────────────────────────────────────

/// Build / rebuild the codebase index. Returns the chunk count.
#[tauri::command]
pub async fn codebase_index_build(project_dir: Option<String>) -> Result<usize, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let root = PathBuf::from(project);
    tokio::task::spawn_blocking(move || build_index(&root))
        .await
        .map_err(|e| format!("index task failed: {e}"))?
}

/// Search the codebase index.
#[tauri::command]
pub async fn codebase_search(
    project_dir: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<CodeSearchHit>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let root = PathBuf::from(project);
    let lim = limit.unwrap_or(12);
    tokio::task::spawn_blocking(move || search_index(&root, &query, lim))
        .await
        .map_err(|e| format!("search task failed: {e}"))?
}
