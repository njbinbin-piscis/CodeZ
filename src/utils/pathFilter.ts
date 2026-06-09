/** Frontend mirror of Rust `path_filter` — defense in depth for watcher events. */

const IGNORED_DIR_NAMES = new Set([
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
]);

const IGNORED_FILE_SUFFIXES = [
  ".db",
  ".db-wal",
  ".db-shm",
  ".db-journal",
  ".sqlite",
  ".sqlite3",
  ".swp",
  ".tmp",
];

export function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, "/");
}

export function isIgnoredRelPath(relNorm: string): boolean {
  const rel = relNorm.replace(/^\.\//, "");
  if (!rel || rel === ".") return true;

  const basename = rel.split("/").pop() ?? rel;
  for (const suffix of IGNORED_FILE_SUFFIXES) {
    if (basename.endsWith(suffix)) return true;
  }
  if (basename.endsWith("~")) return true;

  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return true;

  for (const seg of segments.slice(0, -1)) {
    if (IGNORED_DIR_NAMES.has(seg) || seg.startsWith(".")) return true;
  }

  if (segments.length === 1 && IGNORED_DIR_NAMES.has(segments[0]!)) return true;

  return false;
}

export function shouldWatchPath(relNorm: string): boolean {
  return !isIgnoredRelPath(relNorm);
}
