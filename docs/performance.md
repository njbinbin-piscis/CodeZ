# AgentZ Performance Baseline

## Architecture constraints

- **UI runs in a single Tauri WebView** (React + Monaco). Rust accelerates backend commands, not rendering.
- **Extensions run in a Node sidecar** bridged via Tauri `invoke` + JSON RPC. This shares the renderer event loop with chat and editor UI.
- **Cursor/VS Code** use multi-process isolation (renderer, extension host, editor). AgentZ intentionally trades that for a smaller footprint — performance work focuses on reducing unnecessary work on the one WebView thread.

## File watcher rules (`path_filter`)

Internal paths must **never** emit `ide-file-changed`:

| Category | Examples |
|----------|----------|
| App data | `.agentz/piscis.db`, `journal.db`, `index.db`, `*.db-wal`, `*.db-shm` |
| Dependencies | `node_modules/`, `.venv/` |
| Build output | `target/`, `dist/`, `build/`, `.next/` |
| Dot directories | `.github/`, `.vscode/`, etc. |

Rules live in `src-tauri/src/path_filter.rs` (single source of truth) with a TypeScript mirror in `src/utils/pathFilter.ts`.

## Refresh pipeline

| Trigger | Behavior |
|---------|----------|
| Watcher (user file) | Debounced 250ms → file tree + git via `ProjectEdgeContext.scheduleWorkspaceRefresh` |
| Watcher during agent turn | **Paused** until turn ends (then one forced refresh) |
| Agent `file_write` / `file_edit` | Emit real path; tab reload debounced separately |
| Tab external reload | Only if path matches an open non-dirty tab |

## Dev diagnostics

In development builds, open the browser console and inspect:

```js
window.__agentz_perf.snapshot()
```

Counters: `watcherEventsReceived`, `watcherEventsIgnored`, `workspaceRefreshScheduled`, `workspaceRefreshFlushed`, `tabReloadScheduled`.

## Phase acceptance checks

1. Long agent chat without file edits → **zero** file tree/git refresh from `.agentz` DB writes.
2. Ten rapid `file_edit` tools → ≤2 workspace refreshes; open tabs still hot-reload.
3. Chat streaming → plain text during stream; Markdown once complete; composer typing does not re-render history.
4. Extensions enabled 2h+ → no host OOM; only active editor synced to ext-host.

## Known remaining limits

- No full chat message virtual list (uses `content-visibility` lite optimization).
- LSP `didChange` sends full document text (debounced 300ms) — incremental ranges are a future improvement.
- Linux VM / software WebView rendering can still feel slower than native Electron on bare metal.
