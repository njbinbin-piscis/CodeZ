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

**M0 — dual-mode shell + IDE workspace (in progress).** The frontend is a
Vite + React + TypeScript app with a top-level **IDE / Agent** mode switch.
The IDE workspace (Monaco editor, file tree, tabs, integrated terminal, Git
panel, search, LSP bridge) is ported from openpisci's `Pond/IDE` and decoupled
from the chat Pool — it now takes a standalone `projectDir`. Agent mode is a
placeholder slot for the autonomous task workflow (M4).

`crates/codez-host` links the `pisci-engine` kernel and prints a banner,
proving the git dependency resolves and builds; the Tauri host that bridges
this frontend to the kernel lands in a later milestone.

## Layout

```
CodeZ/
├── Cargo.toml                  # Rust workspace; depends on pisci-engine via git
├── crates/
│   └── codez-host/             # kernel-linked host seed
├── package.json                # frontend (Vite + React + TS)
├── index.html
└── src/
    ├── App.tsx                 # dual-mode top-level shell (IDE / Agent)
    ├── i18n.ts                 # minimal i18next init (English fallbacks)
    ├── services/tauri/         # ide / lsp IPC + folder dialog
    └── workspaces/
        ├── ide/                # ported IDE workspace (decoupled from Pool)
        └── agent/              # Agent-mode placeholder (M4)
```

## Build

Frontend:

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc + vite build
npm run dev         # dev server
```

Kernel host:

```bash
cargo run -p codez-host
```

`cargo` fetches `pisci-engine` from GitHub and compiles the kernel. To develop
the kernel and CodeZ together locally, add a `[patch]` pointing the git source
at a local `../pisci-engine` checkout.

## Design

The full architecture, mode design, VS Code-ecosystem compatibility strategy
and roadmap live in `openpisci/docs/codez-design.md`.
