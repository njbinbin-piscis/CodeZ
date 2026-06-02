# CodeZ — 类 Cursor AI IDE 设计文档

> CodeZ 是一个类 Cursor 的 **AI IDE**，对外提供两种一等模式：
> **IDE 模式**（编辑器为中心，≈ Cursor）与 **Agent 模式**（任务为中心，≈ Codex）。
> 二者共享 [`piscis-engine`](https://github.com/njbinbin-piscis/piscis-engine) 的
> agent 内核（`pisci-core` + `pisci-kernel`），以 git 依赖方式引入。
>
> **本文档描述的是 CodeZ 仓库的真实实现**，而非愿景。所有"已完成 / 计划中"以
> §9 里程碑表为准。

---

## 1. 定位与关键决策

CodeZ 是一个**独立仓库**，只把 `piscis-engine` 当作**共享 agent 内核**消费：

- 复用内核的：agent loop（`pisci_kernel::agent`）、多模型 LLM 客户端、
  中立工具集（`pisci_kernel::tools` 的 file/shell/code_run/search/plan…）、
  策略门（`PolicyGate`）、compaction v2（rolling summary + state frame）、
  headless turn runner（`pisci_kernel::headless`）。
- CodeZ 自己实现的（host 层）：双模式前端、IDE 工作区（Monaco/LSP/终端/Git/watcher）、
  inline AI（Cmd-K / Tab）、代码库索引、`.vsix` 贡献点摄取、worktree 任务隔离、
  只读子 agent 委派、技能/规则/钩子、Repo Wiki。

### 1.1 一个明确的取舍：不复用内核的 Pool/Koi 多智能体编排

内核里有一套完整的 **Pool/Koi 多智能体编排**（coordinator、命名持久 agent、共享任务
看板、`@mention` 调度、子进程 subagent runtime）。**CodeZ 有意不接它**——在 host 装配
工具注册表时显式关闭：

```480:483:src-tauri/src/commands/chat_turn.rs
        pool_event_sink: None,
        subagent_runtime: None,
        coordinator_config: Default::default(),
```

原因：Pool/Koi 那套是为"多个常驻 agent + 看板协作"设计的，**对一个编辑器型 AI IDE 过重**
（需要看板 UI、命名 agent 生命周期、心跳/看门狗/对账协议）。CodeZ 选择更轻的两件套：

1. **`delegate` 只读子 agent**（§5）—— 解决"并行调研、隔离上下文"。
2. **`agent_task` git worktree 隔离**（§6）—— 解决"自治任务、互不污染、可评审"。

---

## 2. 产品形态：一个内核，两种模式

```
┌──────────────────────────────────────────────────────────┐
│  CodeZ                 [ IDE 模式 ]      [ Agent 模式 ]      │
├──────────────────────────────────────────────────────────┤
│  IDE 模式（≈ Cursor）           Agent 模式（≈ Codex）        │
│  以编辑器为中心：               以任务为中心：               │
│  · Monaco + LSP                · 提交目标 → 自治执行         │
│  · Tab 补全 / Cmd-K            · 隔离 worktree/分支          │
│  · 右侧 AI Chat + @引用        · 计划→编辑→跑工具→迭代       │
│  · 行内 diff / Review·Undo     · 任务列表 + diff 评审/合并   │
└──────────────────────────────────────────────────────────┘
   共享：piscis-engine 内核（agent loop / tools / LLM / compaction / 策略）
```

- **IDE 模式**：人在回路、低延迟、编辑器内增量改动，agent 作"副驾"。
- **Agent 模式**：交付目标后自治、长时运行，在隔离 worktree 里产出可评审 diff，
  评审后合并 / 开 PR / 丢弃。

二者复用同一 agent loop，仅 **工具暴露面 + 上下文 + 产物形态**不同。CodeZ 用
`chat_mode`（`agent` / `plan`）切换工具面（见 §4.3）。

---

## 3. 仓库结构与内核复用

```
CodeZ/
├── Cargo.toml                  # Rust workspace；pisci-core / pisci-kernel 走 git 依赖
├── crates/codez-host/          # kernel-link smoke 二进制
├── src-tauri/                  # Tauri 桌面宿主
│   └── src/
│       ├── lib.rs              # builder + 命令注册（能力总表）
│       ├── state.rs           # AppState（终端 / watcher / LSP）
│       ├── context_assembly.rs# 历史重建 + rolling summary + state frame + 预算裁剪
│       ├── journal.rs         # 文件日志（一次 turn 的 Review / Undo）
│       ├── lsp/               # LSP ↔ WebSocket 桥
│       ├── tools/             # delegate / codebase_search / lsp / read_lints / web_fetch / chat_ui*
│       └── commands/          # ide / chat / chat_turn / edit / codebase / agent_task /
│                              #   vsix / session / settings / clawhub / workbench /
│                              #   repo_wiki / interactive / journal / platform
└── src/
    ├── App.tsx                 # 双模式顶层 shell（IDE / Agent）
    ├── services/tauri/         # ide / lsp / chat / agentTask IPC
    └── workspaces/
        ├── ide/                # IDE 工作区 + AssistantPanel + ExtensionsPanel(.vsix)
        └── agent/              # Agent 模式任务列表（目标 → 自治运行 + 评审）
```

内核复用的关键路径：`commands/chat_turn.rs::run_codez_turn` 在 CodeZ 侧装配工具注册表、
系统提示、策略门、harness（`HarnessConfig::for_scheduler`），再跑内核 agent loop，
并把 `AgentEvent` 通过 Tauri 事件通道流给前端。

---

## 4. IDE 模式（≈ Cursor）

### 4.1 编辑器底座（M0，已完成）
Monaco 编辑器 + 完整 IDE 命令：文件树/读写、Git（status/diff/branches/add/reset/
discard/commit/checkout/create-branch）、PTY 终端（xterm）、文件 watcher、
LSP ↔ WebSocket 桥（`ide_lsp_*`）。打开任意本地文件夹即进入 IDE（独立 `projectDir`，
不依赖任何协作池）。

### 4.2 三大行内 AI 能力
- **Cmd-K 行内编辑（M2）**：选区 → 输入指令 → `inline_edit`（单发 LLM 变换，无 agent
  loop）→ 编辑器内真实 inline diff（新行绿、原行红）→ Enter 接受 / Esc 拒绝（undo）。
- **Tab 补全 / ghost text（M5）**：`ai_inline_completion(file, prefix, suffix, cursor)`
  → 轻量补全，Monaco inline completions provider 渲染 ghost text。
- **Chat 侧栏 + @引用 + Apply**：`AssistantPanel` 驱动 `chat_send` → `run_codez_turn`
  单 agent turn，流式 `AgentEvent`（文本 + 工具调用），agent 直接改文件、IDE watcher
  实时回灌。`@引用` 在 host 侧 `expand_file_refs` 展开：
  - `@path/to/file` → 行内注入文件内容（单文件上限 12K 字符，总上限 48K）；
  - `@codebase` → 跑代码库索引取 top 命中，行内注入（见 §7）。

### 4.3 计划模式（Plan mode）
`chat_mode = "plan"` 时禁用全部写/执行类工具
（`file_write` / `file_edit` / `shell` / `code_run` / `process_control` / `elevate` /
`email` / `ssh` / `web_search` / `memory_store`），用于"只读探索 / 出方案"。
`agent` 模式则放开全量工具。

### 4.4 Review / Undo
每个 turn 通过 `FileJournal::begin_turn` + before/after-tool 钩子把这一轮的文件快照
分组，`journal_list_changes` / `journal_undo_turn` 支持回看与整轮撤销。

---

## 5. 多 agent / 子 agent：`delegate`（已完成，M7）

CodeZ 的多 agent 能力就是 **`delegate` 只读研究子 agent**，而不是 Pool/Koi。

- 主 agent 把一段范围明确的**只读调研**（"找 X 的所有调用点 / 说清 Y 的工作方式 /
  定位控制 Z 的配置"）交给子 agent；子 agent 跑内核 agent loop，但用**计划模式的
  只读工具面**（explore + `codebase_search` + LSP，无写/shell/code_run），10 轮预算、
  240s 超时，**不能再委派**（防递归）。
- 子 agent 的过程不进主 agent 上下文，只把**最终发现**作为工具结果回传 —— 保持主
  上下文干净。
- **并发**：`delegate` 标记为 `is_read_only() = true`，因此内核 agent loop 会把同一轮
  里的多个 `delegate` 调用**并行**执行（只读工具走并发批，写工具才串行）。这就是
  CodeZ 版的"并行子 agent 调研"。

```64:68:src-tauri/src/tools/delegate.rs
    fn is_read_only(&self) -> bool {
        // The delegated sub-agent is itself read-only, so delegating is safe to
        // run concurrently with other read-only tools.
        true
    }
```

**边界（与 Cursor 的差异）**：CodeZ 目前**没有**可并发的"写型"子 agent，也没有持久命名
agent 池 / 看板 / `@mention` 编排。需要"多个能改代码的 agent 并行干活"时，走 Agent
模式的多 worktree 任务（§6），每个任务一个隔离工作树，而不是一回合内并发多个写 agent。

---

## 6. Agent 模式（≈ Codex）：worktree 任务隔离（已完成，M3 + M4）

与 IDE 模式最大差异：**任务化、自治、隔离、可评审**。**不是看板/Pool**，而是
"任务列表 + 每任务一棵隔离 git worktree"。

### 6.1 任务生命周期
```
提交目标(prompt + 项目 + 可选基准分支)
   │
   ├─ 1. 隔离：git worktree 新建 codez/task-<id> 分支
   │        （worktree 落在 <project>/../.codez-worktrees/task-<id>）
   ├─ 2. 自治：跑 run_codez_turn（agent 模式全量工具）— 计划→编辑→跑工具→迭代
   ├─ 3. 流式：步骤（文本 + 工具调用）实时回前端；可 Stop 取消在飞 turn
   ├─ 4. 评审：Changes 面板看 base...branch 的改动文件 + 逐文件 side-by-side diff
   └─ 5. 收尾：合并(no-ff) / 一键开 PR(gh) / 丢弃(删 worktree + 分支)
```

相关命令（`commands/agent_task.rs`）：`agent_task_create` / `_list` /
`_changed_files` / `_file_diff` / `_merge` / `_open_pr` / `_discard`。主工作树永不被
直接写入，行为不端的 agent 也污染不了用户 checkout。

### 6.2 并行多任务
多个 Agent 任务各自一棵 worktree + 分支 + kernel 会话，可独立提交、独立评审，天然
并行隔离。**这是 CodeZ 的"多 agent 并行"落点**（任务级并行，而非单任务内多 agent）。

---

## 7. 代码库索引（已完成，M5）

- 实现：`commands/codebase.rs` 把源文件按 **50 行窗口**分块，存进
  `{project}/.codez/index.db`（SQLite）。
- 检索：**关键词 / 词频排序 + 路径名加权**（非向量嵌入），不需要 embedding API key。
  schema 故意留简单，后续可加一列 embedding，复用 `pisci_kernel::memory::vector`。
- 暴露：`codebase_search` 工具（给 agent）+ `@codebase` 行内召回（给 IDE chat）。
- 构建：`codebase_index_build` 全量重建；查询时索引为空会惰性构建；可挂 watcher 用
  `index_file` 做单文件增量更新。

---

## 8. 技能 / 规则 / 钩子 / MCP（已完成，M6）

- **ClawHub 技能市场**：`clawhub_search` / `clawhub_install`；安装到 `{config}/skills/*/`。
  turn 启动时按"渐进式披露"注入 `## Available skills`（仅列 name + 摘要，命中任务时让
  agent 先 `file_read` 完整 `SKILL.md`）。可执行型技能落在 `{config}/user-tools/`。
- **项目规则**：`{workspace}/.codez/rules/`（优先）或 `.cursor/rules/`（兼容）下的
  `*.md` / `*.mdc` 拼成 `## Project rules` 注入为系统约束。
- **钩子**：`hooks.json` 的 `beforeAgentTurn` 等事件钩子，输出注入为附加系统上下文。
- **MCP**：`settings.mcp_servers` 在 turn 装配时通过 `register_mcp_tools` 连接 stdio/SSE
  服务器并注册其工具。
- **管理面**：`commands/workbench.rs`（skills 列表/卸载、rules CRUD/启停、hooks 读写/运行）。

---

## 9. 里程碑与进度（真实状态）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 双模式 shell + IDE 工作区（文件/Git/终端/watcher/LSP）+ Tauri 宿主 | ✅ 已完成 |
| **M1** | IDE AI chat 侧栏（单 agent turn，流式事件，`@file`） | ✅ 已完成 |
| **M2** | 类 Cursor chat&编辑：markdown 渲染、会话侧栏(列表/新建/删除/fork)、消息队列、Stop、Cmd-K inline edit | ✅ 已完成 |
| **M2.5** | `.vsix` 贡献点：主题 ✅ / snippet ✅ / LSP ✅；TextMate 语法 ⏳ | 🟡 部分完成 |
| **M3** | Agent 模式任务列表：目标→自治运行、流式步骤、历史任务侧栏、Changes 评审面板 | ✅ 已完成 |
| **M4** | Agent 任务隔离：git worktree + 分支 + diff 评审 + 合并/PR/丢弃 | ✅ 已完成 |
| **M5** | 代码库索引(`.codez/index.db`，关键词排序) + `codebase_search` + `@codebase` + Tab 补全 | ✅ 已完成 |
| **M6** | MCP 服务器 + ClawHub 技能 + 项目规则 + 钩子 + user-tools | ✅ 已完成 |
| **M7** | SubAgent 委派：`delegate` 只读研究子 agent（可并发、防递归） | ✅ 已完成 |
| **M8** | Repo Wiki（`repo_wiki_generate`）+ 自动模型路由（`CODEZ_AUTO_MODEL_ROUTING`，plan→快/agent→强） | ✅ 已完成 |

**计划中 / 未做**：
- 索引升级为真正向量嵌入（复用 `memory::vector` 的 cosine + hybrid）。
- `.vsix` 的 TextMate 语法（`vscode-textmate` + `vscode-oniguruma` WASM）与 DAP 调试。
- headless / 云端长时任务 runner 与沙箱化（内核已具 `pisci-cli`/NDJSON 基建可铺路）。

---

## 10. VS Code `.vsix` 兼容（M2.5）

> 核心事实：CodeZ 用的是 **Monaco**（编辑器内核），不是完整 VS Code 工作台。
> 策略：把 `.vsix` 当"声明式贡献点数据包"消费，**不执行插件任意 JS**。

`commands/vsix.rs::import_vsix` 解压 `.vsix`（zip），读 `extension/package.json` 的
`contributes.*` 按白名单分发：

| 贡献点 | 状态 | 方式 |
|---|---|---|
| 颜色主题 | ✅ | `tokenColors` + workbench `colors` → `monaco.editor.defineTheme`，全局应用并持久化 |
| Snippets | ✅ | `contributes.snippets` → 按语言注册 Monaco 补全项 |
| 语言服务器(LSP) | ✅（已有桥） | 复用 `ide_lsp_*` |
| TextMate 语法 | ⏳ 计划 | 需 `vscode-textmate` + `vscode-oniguruma`(WASM) |
| 命令 / webview / `vscode.*` API | ❌ 不做 | 需完整扩展宿主，等于重写 VS Code |

主题语法色为近似（TextMate scope 与 Monaco tokenizer 不 1:1），workbench 颜色承载主色调。

**许可证边界**：让用户**自带 `.vsix`** 或走 **Open VSX**，规避 VS Code Marketplace ToS。

---

## 11. 关键风险与取舍

1. **延迟 vs 质量**：Tab/Cmd-K 用单发轻量路径，与 Chat/Agent 的大模型分离；M8 的自动
   模型路由（plan→快、agent→强）是 opt-in，默认不静默覆盖用户选择。
2. **索引成本/精度**：当前是关键词排序而非语义嵌入 —— 零依赖、零费用，但召回弱于向量；
   schema 已留好升级位。大仓库靠忽略目录 + 50 行分块 + 上限（深度 12、2 万文件）控规模。
3. **多 agent 复杂度**：刻意不引 Pool/Koi 看板，避免命名 agent 生命周期/心跳/对账协议的
   重量级机制；并发只通过"只读 `delegate`"和"多 worktree 任务"两条安全路径达成。
4. **自治边界**：Agent 任务全部隔离在 worktree 分支，主分支永不被直接污染；`delegate`
   子 agent 只读、不可递归。
5. **diff apply 一致性**：Cmd-K inline diff 与 agent 改动都经编辑器/journal，Review·Undo
   兜底整轮回滚。
