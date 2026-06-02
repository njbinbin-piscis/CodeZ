# CodeZ

A Cursor-like **AI IDE** with two first-class modes, built on the shared
[`piscis-engine`](https://github.com/njbinbin-piscis/piscis-engine) agent kernel:

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
`@path/to/file`.

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

**M2.5 — VS Code `.vsix` compat (partial, done).** Per the design's
"contribution-point data pack" approach (no extension JS is executed), the
Extensions panel imports a `.vsix` (zip) via the `import_vsix` host command and
consumes its declarative contributions:

| Contribution | Status | How |
| --- | --- | --- |
| Color themes | ✅ | `tokenColors` + workbench `colors` → `monaco.editor.defineTheme`; applied globally and persisted across reloads |
| Snippets | ✅ | `contributes.snippets` → Monaco completion provider per language |
| Language servers (LSP) | ✅ (existing) | reuse the `ide_lsp_*` bridge |
| TextMate grammars | ⏳ planned | needs `vscode-textmate` + `vscode-oniguruma` WASM |
| Commands / webview / `vscode.*` API | ❌ out of scope | requires a full extension host |

Theme syntax colors are approximate (TextMate scopes don't map 1:1 onto
Monaco's tokenizer) but the workbench colors carry the dominant look.

**M3 — Agent mode (done).** The Agent workspace is a Codex-style **task list**
(not a multi-agent kanban board): each task is a kernel session. Submit a goal
and the agent plans → edits → runs tools in the open project with streamed steps
(text + tool calls), a Stop button, a sidebar to open or delete past tasks, and
a Changes panel showing the resulting `git status` for review. The kernel event channel is shared with the
IDE chat, so each surface only consumes events while it is the one running.

**M4 — Agent task isolation (done).** Each Agent-mode task runs inside its own
`git worktree` on a fresh `codez/task-<id>` branch under `../.codez-worktrees/`,
so the main checkout is never written to directly. The Changes panel diffs
`base...branch` for review, then the task can be **merged** (no-ff), **opened as
a PR** (`gh`), or **discarded** (worktree + branch removed). Multiple tasks run
in parallel, each isolated in its own worktree.

**M5 — Codebase index + Tab completion (done).** `commands/codebase.rs` chunks
source files into 50-line windows in `{project}/.codez/index.db` and answers
`codebase_search` / `@codebase` with keyword/term-frequency ranking + a path-name
boost (no embedding API key required; schema leaves room for vectors later). The
editor also has **Tab ghost-text completion** via `ai_inline_completion`.

**M6 — Skills, rules, hooks, MCP (done).** ClawHub skill marketplace
(`clawhub_search` / `clawhub_install`) with progressive-disclosure `SKILL.md`
injection; project rules from `.codez/rules/` (or `.cursor/rules/`); `hooks.json`
event hooks (`beforeAgentTurn`); and MCP servers from settings registered as tools.

**M7 — SubAgent delegation (done).** The main agent can `delegate` a scoped,
**read-only** research task to a focused sub-agent (kernel loop in plan-mode tool
surface, bounded budget/timeout, no recursion). It is marked read-only so several
delegations run concurrently. CodeZ deliberately does **not** wire the kernel's
Pool/Koi coordinator/board — see `docs/codez-design.md` §1.1.

**M8 — Repo Wiki + auto model routing (done).** `repo_wiki_generate` builds a
module/architecture overview from the index; opt-in `CODEZ_AUTO_MODEL_ROUTING`
picks a fast model for plan mode and a stronger one for agent mode.

`crates/codez-host` is the original kernel-link smoke binary and still builds.

### Configuration

The chat agent reads `config.json` (LLM provider + API key + model) and writes
`pisci.db` in the app-data dir for `com.codez.desktop`, or in `$CODEZ_CONFIG_DIR`
if set (you can point this at an existing openpisci config dir). Without a
configured API key, `chat_send` returns a clear error.

## Layout

```
CodeZ/
├── Cargo.toml                  # Rust workspace; depends on piscis-engine via git
├── crates/
│   └── codez-host/             # kernel-link smoke binary
├── src-tauri/                  # Tauri desktop host
│   ├── src/
│   │   ├── lib.rs              # builder + command registration
│   │   ├── state.rs           # AppState (terminals / watchers / LSP)
│   │   ├── lsp/               # LSP ↔ WebSocket bridge
│   │   └── commands/          # ide / chat / session / edit / vsix / platform
│   ├── tauri.conf.json
│   └── capabilities/
├── package.json                # frontend (Vite + React + TS)
├── index.html
└── src/
    ├── App.tsx                 # dual-mode top-level shell (IDE / Agent)
    ├── i18n.ts                 # minimal i18next init (English fallbacks)
    ├── services/tauri/         # ide / lsp / chat IPC + folder dialog
    └── workspaces/
        ├── ide/                # IDE workspace + AssistantPanel + ExtensionsPanel (.vsix)
        └── agent/              # Agent-mode task list (goal → autonomous run + review)
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

Packaging (installers):

```bash
npm run tauri build            # → src-tauri/target/release/bundle/{deb,appimage,rpm}
```

CI builds the Linux `.deb` + `.AppImage` bundles via
`.github/workflows/release.yml` (using `tauri-action`) on a pushed `v*` tag or
manual dispatch, attaching them to a draft GitHub release and as workflow
artifacts.

`cargo` fetches `piscis-engine` from GitHub and compiles the kernel. To develop
the kernel and CodeZ together locally, add a `[patch]` pointing the git source
at a local `../piscis-engine` checkout. The desktop host needs the usual Tauri
Linux system libs (webkit2gtk-4.1, gtk-3, libsoup-3).

## Design

The full architecture, mode design, VS Code-ecosystem compatibility strategy
and roadmap live in `docs/codez-design.md`.
