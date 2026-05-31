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

Skeleton. `crates/codez-host` currently just links the kernel and prints a
banner — it proves the `pisci-engine` dependency resolves and builds. The
Tauri UI shell and the new `edit` / `index` / `agent_task` modules layer on
top per the milestones in the design doc.

## Layout

```
CodeZ/
├── Cargo.toml            # workspace; depends on pisci-engine via git
└── crates/
    └── codez-host/       # host shell (seed of the IDE/Agent app)
```

## Build

```bash
cargo run -p codez-host
```

This fetches `pisci-engine` from GitHub and compiles the kernel. To develop
the kernel and CodeZ together locally, add a `[patch]` pointing the git
source at a local `../pisci-engine` checkout.

## Design

The full architecture, mode design, VS Code-ecosystem compatibility strategy
and roadmap live in `openpisci/docs/codez-design.md`.
