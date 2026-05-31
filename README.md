# CodeZ

A Cursor-like **AI IDE** with two first-class modes, built on the shared
[`pisci-engine`](https://github.com/njbinbin-pisci/pisci-engine) agent kernel:

- **IDE mode** (≈ Cursor): editor-centric — Monaco + LSP, Tab completion,
  Cmd-K inline edit, an AI chat side panel with `@`-references and inline
  diff apply.
- **Agent mode** (≈ Codex): task-centric — submit a task, the agent works
  autonomously in an isolated git worktree (plan → edit → test → iterate),
  then you review the diff / open a PR.

Both modes reuse one kernel (`pisci-core` + `pisci-kernel`) so the editor
副驾 and the autonomous agent behave identically.

## Status

**M0 — dual-mode shell + IDE workspace + Tauri host (done).** The frontend is
a Vite + React + TypeScript app with a top-level **IDE / Agent** mode switch.
The IDE workspace (Monaco editor, file tree, tabs, integrated terminal, Git
panel, search, LSP bridge) is ported from openpisci's `Pond/IDE` and decoupled
from the chat Pool — it now takes a standalone `projectDir`. The `src-tauri`
host implements the IDE commands (file I/O, git, search, PTY terminal, file
watcher, LSP ↔ WebSocket bridge) plus `open_path`.

**M1 — AI chat sidebar (done).** IDE mode has a chat panel that drives a single
agent turn on the kernel via `pisci_kernel::headless::run_pisci_turn`. The
backend `chat_send` command streams `AgentEvent`s (text + tool calls) to the UI
over a Tauri event channel; the agent edits files in place with its own tools
and the IDE's file watcher reloads them. Reference files in a prompt with
`@path/to/file`. Agent mode (full autonomous task board) remains a placeholder
for M4.

**M2 — Cursor-like chat & editing (done).** Assistant messages render as
GitHub-flavored markdown with syntax-highlighted, copyable code blocks. The chat
panel has a session sidebar (`☰` list / switch / delete, `＋` new, `⑂` fork —
fork copies the current session's messages into a fresh one), queues messages
typed while the agent is busy, and shows a **Stop** button that cancels the
in-flight turn via the engine's `run_pisci_turn_cancellable` hook. The editor
supports **Cmd-K inline edit**: select code, press ⌘K/Ctrl-K, type an
instruction, and a single-shot LLM transform (`inline_edit`, no agent loop) is
applied in place as a true inline diff — new lines highlighted green with the
replaced original shown above in red — then Enter accepts or Esc rejects (undo).

**M3 — Agent mode (done).** The Agent workspace is a Codex-style task board:
each task is a kernel session, submit a goal and the agent plans → edits → runs
tools in the open project with streamed steps (text + tool calls), a Stop
button, a task list (open / delete past runs), and a Changes panel showing the
resulting `git status` for review. The kernel event channel is shared with the
IDE chat, so each surface only consumes events while it is the one running.

`crates/codez-host` is the original kernel-link smoke binary and still builds.

### Configuration

The chat agent reads `config.json` (LLM provider + API key + model) and writes
`pisci.db` in the app-data dir for `com.codez.desktop`, or in `$CODEZ_CONFIG_DIR`
if set (you can point this at an existing openpisci config dir). Without a
configured API key, `chat_send` returns a clear error.

## Layout

```
CodeZ/
├── Cargo.toml                  # Rust workspace; depends on pisci-engine via git
├── crates/
│   └── codez-host/             # kernel-link smoke binary
├── src-tauri/                  # Tauri desktop host
│   ├── src/
│   │   ├── lib.rs              # builder + command registration
│   │   ├── state.rs           # AppState (terminals / watchers / LSP)
│   │   ├── lsp/               # LSP ↔ WebSocket bridge
│   │   └── commands/          # ide / chat / session / edit / platform
│   ├── tauri.conf.json
│   └── capabilities/
├── package.json                # frontend (Vite + React + TS)
├── index.html
└── src/
    ├── App.tsx                 # dual-mode top-level shell (IDE / Agent)
    ├── i18n.ts                 # minimal i18next init (English fallbacks)
    ├── services/tauri/         # ide / lsp / chat IPC + folder dialog
    └── workspaces/
        ├── ide/                # ported IDE workspace + AssistantPanel (chat)
        └── agent/              # Agent-mode task board (goal → autonomous run)
```

## Build

Frontend:

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc + vite build
npm run dev         # dev server
```

Desktop host (Rust):

```bash
cargo check -p codez-desktop   # or: cargo tauri dev (needs the Tauri CLI)
cargo run -p codez-host        # kernel-link smoke binary
```

`cargo` fetches `pisci-engine` from GitHub and compiles the kernel. To develop
the kernel and CodeZ together locally, add a `[patch]` pointing the git source
at a local `../pisci-engine` checkout. The desktop host needs the usual Tauri
Linux system libs (webkit2gtk-4.1, gtk-3, libsoup-3).

## Design

The full architecture, mode design, VS Code-ecosystem compatibility strategy
and roadmap live in `openpisci/docs/codez-design.md`.
