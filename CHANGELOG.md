# Changelog

All notable changes to AgentZ are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.5] - 2026-06-12

### Added

- **统一资源库**：标题栏 Store 图标打开「资源库」面板，合并技能/工具/智能体/团队/连接器/匿名代理的已安装、发现与编排视图；设置仅保留模型、消息渠道、扩展、规则、钩子。
- **WorkZ 通用智能体**：输入框下方技能/连接器多选；空列表可深链到资源库发现页。
- **协作增强**：pool 按 `team_id` / `workflow_run_id` 隔离（`piscis-engine v0.8.59`）、depends_on 等待 UI、patrol/heartbeat、连接器白名单。

### Changed

- 设置「助理」改名为「消息渠道」；匿名代理文案与资源库 i18n 统一（中英文）。
- 移除 MarketplacePanel、ClawHubPanel 及设置内技能/工作室/子代理/连接器 Tab。

## [0.5.4] - 2026-06-12

### Added

- **WorkZ 协作机制全面修复**：协调者 `pool_session_id` 绑定、`swarm_coordinator` 收敛协议、成员 Koi **Stop Gate** 六层 prompt、pool 按 `team_id` 隔离、workflow run 独立 pool、depends_on 等待 UI、patrol/heartbeat、workflow driver 互斥与 LLM 分支 fail-fast。
- **CodeZ Browser E2E**: `browser-changed` event sync, auto-open Browser tab on agent actions, close guard when agent is active.
- **Browser automation**: RobotZ `snapshot`/`ref`/`lock`/`fill`, assert DSL (`assert_url`, `assert_visible`, `assert_text`), `wait_for_text`.
- **Kernel alignment**: `piscis-engine v0.8.58` (`web_fetch`, `piscis-ide-tools`), shared `robotz-browser v0.1.2` with IDE panel.
- **Skills / debug**: `codez-e2e-testing` skill; `debug_scenarios_list` with four browser regression prompts.

### Changed

- System prompt and Plan mode docs for `web_fetch` vs `browser` E2E workflow.
- `toolDisplay` summaries for `browser` and `web_fetch`.

## [0.5.3] - 2026-06-10

### Fixed

- **Workflow designer toolbar**: add-node and auto-layout buttons now share a fixed 28px height with aligned glyphs and labels.

## [0.5.2] - 2026-06-10

Complete i18n coverage for IDE explorer controls, git panel, unsaved prompts, and interactive chat forms.

### Fixed

- **Explorer**: expand-all / collapse-all tooltips showed raw keys (`ide.expandAll`) instead of translated text.
- **Git panel**: `noGitRepos` message; **editor**: unsaved close confirmations.
- **Interactive cards**: all validation and wizard strings now localized (EN + ZH).

## [0.5.1] - 2026-06-10

Workflow designer UX — structured branch/loop conditions, auto fit view, and edge flow animation.

### Added

- **Condition builder** for workflow branch (expr) and loop `exit_when`: pick blackboard key, operator, and value with live expression preview; advanced raw-text mode still available.
- **Expr branch paths**: true/false target dropdowns auto-set edge labels; graph validation for missing paths and unknown keys.

### Changed

- **Workflow canvas** auto fit view on open and after auto-layout; edge dash animation flows source → target (arrow direction).

## [0.5.0] - 2026-06-10

Trusted skill evolution — quadrant storage, background review, Curator, and Settings UI.
Requires **piscis-engine v0.8.57**.

### Added

- **Quadrant skill storage**: `skills/installed/`, `.draft/`, `learned/`, `.archive/` under the global config dir.
- **`skill_manage` tool**: agent-mode controlled writes to draft/learned skills (`safe_join` path guard).
- **Background review**: post-turn memory extract + skill review fork (configurable via `skill_evolution` in settings).
- **Curator**: stale marking, archive, LLM merge; idle scheduler every 30 minutes.
- **Memory hardening**: L2 compaction (3×) triggers session memory consolidation.
- **Settings → Skills**: evolution panel (promote/discard/lock), Curator controls, review toggle.
- **Global skill DB**: `{config_dir}/piscis.db` for skill metadata/revisions (separate from project session DB).

### Changed

- **ClawHub install** targets `skills/installed/` and registers skills in the global DB.
- **piscis-engine** dependency bumped to **v0.8.57**.

## [0.4.6] - 2026-06-09

Edge drawer polish, explorer expand/collapse, and faster git refresh after agent edits.

### Changed

- **Global edge drawer**: compact number badge (no label overlap with title bar);
  changes and artifacts merged into one panel with explicit close; flat artifact list.
- **CodeZ chat**: code blocks show copy only — removed Apply-to-editor button.
- **Context ring**: progress ring and percentage both use `totalInputBudget`.

### Added

- **Explorer**: expand-all / collapse-all toolbar buttons.
- **Agent turns**: emit `ide-file-changed` after file-modifying tools so git status
  and the file tree refresh even when inotify is delayed.

## [0.4.5] - 2026-06-08

WorkZ-first startup, per-mode model memory, and quieter composer placeholders.

### Changed

- **First launch** opens **WorkZ** by default; later launches restore the mode you
  exited in (saved in workspace layout).
- **CodeZ / WorkZ** title-bar toggle: WorkZ is listed before CodeZ.
- **Model picker** selections are saved independently for CodeZ and WorkZ and
  restored on the next app start.
- **Composer placeholder** text is smaller and closer to the background so it is
  less distracting.

### Added

- **WorkZ**: full artifact preview (images, PDF, Markdown, HTML, code), tree-style
  artifacts drawer, worktree path resolution, three-tab task view (main / Koi
  chatroom / coordination log), task-bound team mode, and sidebar status fixes.
- **CodeZ**: global edge drawer for git changes and artifacts; inline file diff
  cards after agent turns; task-card composer layout; Flash LLM session titles for
  CodeZ and WorkZ.
- **Extension host**: dev build sync, ready-handshake race fix, and more reliable
  `$initialize` startup.

### Fixed

- CodeZ black screen from `UserMessage` / `chatFileRefs` parse bugs and duplicate
  React keys in tool steps.
- Composer image chips persisting after send (async paste + attach replay).
- Extension host RPC timeouts and stale `host.js` in dev builds.
- Browser viewport CDP API for chromiumoxide 0.9.

## [0.4.4] - 2026-06-08

Replace native `<select>` dropdowns with theme-aware `DropdownSelect` so popup
lists match the dark UI (fixes unreadable white/gray OS menus in Tauri).

### Changed

- **WorkZ**: team and agent pickers above the goal input now use the same styled
  menu as CodeZ composer (assistant / skills / model).
- **CodeZ composer**: menu implementation consolidated into shared `DropdownSelect`.
- **Settings, Studio, Workflow designer, Connectors, Hooks, IM assistants**:
  all form selects migrated to `DropdownSelect`.
- **`chat_ui` forms**, project picker, and bottom-panel output channel selector
  also use the shared component.

## [0.4.3] - 2026-06-07

Rich assistant message rendering aligned with OpenPiscis, plus CI clippy fix
from v0.4.2.

### Added

- Agent chat markdown: **Mermaid** diagrams (` ```mermaid `), **HTML** (inline or
  ` ```html ` blocks, sanitized), **KaTeX** math (`$…$` / `$$…$$`), GFM tables
  with horizontal scroll, and clickable images.
- `chat_ui` card `text` / `section.description` blocks now render markdown
  (mermaid, HTML, formulas) instead of plain text.
- Render error boundary: malformed markdown falls back to a code block instead of
  breaking the chat pane.

### Fixed

- `WorkspaceCloseGate`: implement `Default` so `cargo clippy -D warnings` passes
  in CI (Desktop host job).

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

[0.4.5]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.4.5
[0.4.4]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.4.4
[0.4.3]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.4.3
[0.3.1]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.3.1
[0.3.0]: https://github.com/njbinbin-piscis/AgentZ/releases/tag/v0.3.0
