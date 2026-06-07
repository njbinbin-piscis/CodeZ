# Changelog

All notable changes to AgentZ are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-06-07

Production-readiness release: CI quality gates, test coverage, logging, and
release documentation. Still **unsigned / manual download** — see
[`RELEASE.md`](RELEASE.md).

### Added

- CI gates: `cargo test`, `cargo clippy -D warnings`, `npm test`, ESLint.
- Frontend `vitest` suite for `validateGraph`; Rust unit tests for workflow
  routing (`branch_target`, `loop_step`, `fault_decision`) and run persistence.
- Daily-rolling file logs at `{config}/logs/agentz.log` (plus stdout).
- `CHANGELOG.md`, `LICENSE`, `.env.example`, `RELEASE.md`.

### Changed

- Workflow runner and persistence refactored for testability (no behavior change).
- Swarm patrol hardened against poisoned locks and single-round panics.
- Brand cleanup: AgentZ naming in LSP bridge, DingTalk UA, i18n hints.
- `extension-host` version aligned to `0.3.1`.

## [0.3.0] - 2026-06

First publicly released build. Distributed **unsigned / manual download** across
Linux (x86_64 + aarch64), Windows (x86_64 + aarch64) and macOS (Apple Silicon +
Universal); see [`RELEASE.md`](RELEASE.md) for install notes.

### Added

- **Teams: dual execution modes.** A team can now run in one of two modes:
  - **Swarm** — emergent, coordinator-driven collaboration. Member agents share
    an organizational spec (`org_spec`) which is now injected into every member
    turn, and a background patrol recovers stale tasks and activates pending
    todos so swarm runs do not stall.
  - **Workflow** — deterministic, graph-driven execution with `start` / `end` /
    `agent` / `branch` / `loop` / `human` nodes, a shared blackboard, branch
    conditions (LLM classification or simple expression), bounded loops, and a
    total-step circuit breaker.
- **Workflow designer** — a React Flow canvas with node inspector, semantic edge
  coloring/labels, auto-layout, and live graph validation.
- **Workflow run experience** — live run panel with streaming agent output,
  human-in-the-loop steps, cancel, and re-run; plus a run-history browser with
  live updates, per-run delete, and clear-finished.
- **Node-level fault tolerance** — agent nodes support `max_retries` and an
  `on_error` policy (`fail` or `skip`).
- Built-in "Code Review Loop" sample workflow team.

### Changed

- Coordinator preamble (role + `org_spec`) is now injected only on the first
  turn of a swarm session instead of repeating every turn.

### Quality / tooling

- Extracted pure decision functions (`branch_target`, `loop_step`,
  `fault_decision`) and `&Path` persistence cores for unit testing.
- Added Rust unit tests (routing, loop bounds, retry/skip, run persistence
  guards) and a frontend `vitest` suite covering `validateGraph`.
- CI now runs `cargo test`, `cargo clippy -D warnings`, `npm test`, and ESLint;
  added Prettier config and `lint`/`format` scripts.
- Hardened the swarm patrol against poisoned locks and single-round panics.

[0.3.1]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.3.1
[0.3.0]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.3.0
