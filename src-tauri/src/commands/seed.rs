//! First-run seeding of built-in preinstall packs (Phase 5).
//!
//! On the first launch (guarded by a sentinel file in the config dir) this
//! writes a small set of starter **agents** (Architect / Coder / Reviewer +
//! Researcher / Writer) and **teams** (`fullstack-squad`, `research-duo`) into
//! `{config}/agents/<id>/agent.json` and `{config}/teams/<id>/team.json`.
//!
//! Seeding is non-destructive: an entry is only written when its target file is
//! absent, so user edits or deletions are never clobbered. The sentinel records
//! the seed version so the set can be extended in future releases without
//! re-creating things the user removed.

use std::path::Path;

use tauri::AppHandle;
use tracing::{info, warn};

use crate::commands::agents::{safe_id, AgentManifest};
use crate::commands::data_scope::resolve_global_config_dir;
use crate::commands::teams::TeamManifest;
use crate::commands::workflow::WorkflowGraph;

/// Bump when the built-in pack contents change to re-run the (non-destructive) seed.
const SEED_SENTINEL: &str = ".layered-seed-v2";

/// A demonstrable workflow team: coder ⇄ reviewer review loop that exits once
/// the reviewer's output contains "approved" (capped at 3 iterations).
fn code_review_workflow() -> Option<WorkflowGraph> {
    serde_json::from_value(serde_json::json!({
        "entry": "start",
        "max_total_steps": 40,
        "nodes": [
            { "id": "start", "type": "start", "label": "开始", "x": 60, "y": 200 },
            {
                "id": "review-loop",
                "type": "loop",
                "label": "评审循环",
                "x": 280,
                "y": 200,
                "guard": { "max_iterations": 3, "exit_when": "review contains approved" }
            },
            {
                "id": "code",
                "type": "agent",
                "label": "编码",
                "agent_id": "coder",
                "output_key": "code",
                "x": 520,
                "y": 100,
                "prompt_template": "实现下面的任务。如果有上一轮评审意见，请逐条修复。\n\n任务：{{goal}}\n\n上一轮代码：\n{{code}}\n\n上一轮评审意见：\n{{review}}"
            },
            {
                "id": "review",
                "type": "agent",
                "label": "评审",
                "agent_id": "reviewer",
                "output_key": "review",
                "x": 520,
                "y": 300,
                "prompt_template": "评审下面的实现是否正确、是否满足任务要求。若可以接受，请在回复中明确包含单词 approved；否则列出必须修改的问题清单。\n\n任务：{{goal}}\n\n实现：\n{{code}}"
            },
            { "id": "end", "type": "end", "label": "结束", "x": 760, "y": 200 }
        ],
        "edges": [
            { "from": "start", "to": "review-loop" },
            { "from": "review-loop", "to": "code", "label": "body" },
            { "from": "review-loop", "to": "end" },
            { "from": "code", "to": "review" },
            { "from": "review", "to": "review-loop" }
        ]
    }))
    .ok()
}

/// Build an agent manifest with sensible defaults for the seed set.
fn agent(
    id: &str,
    name: &str,
    role: &str,
    icon: &str,
    color: &str,
    description: &str,
    system_prompt: &str,
) -> AgentManifest {
    AgentManifest {
        id: id.to_string(),
        name: name.to_string(),
        role: role.to_string(),
        icon: icon.to_string(),
        color: color.to_string(),
        description: description.to_string(),
        system_prompt: system_prompt.to_string(),
        skills: Vec::new(),
        tools: Vec::new(),
        mcp_servers: Vec::new(),
        connectors: Vec::new(),
        llm_provider_id: None,
        max_iterations: 0,
        task_timeout_secs: 0,
        koi_id: None,
    }
}

fn builtin_agents() -> Vec<AgentManifest> {
    vec![
        agent(
            "architect",
            "架构师 Architect",
            "架构设计",
            "🏛️",
            "#7c6af7",
            "负责需求拆解、技术选型与系统设计，输出清晰的实现方案。",
            "你是资深软件架构师。先澄清需求与约束，再给出模块划分、接口契约与分步实现计划。优先考虑可维护性、扩展性与简洁性，避免过度设计。",
        ),
        agent(
            "coder",
            "工程师 Coder",
            "编码实现",
            "🛠️",
            "#26de81",
            "依据方案实现功能，编写整洁、可测试的代码并修复缺陷。",
            "你是高效的软件工程师。严格按既定方案与代码规范实现功能，保持改动聚焦，必要时补充测试，并在完成后简要说明关键改动与验证方式。",
        ),
        agent(
            "reviewer",
            "评审 Reviewer",
            "代码评审",
            "🔍",
            "#f7b731",
            "审查代码正确性、安全性与风格，给出可执行的改进建议。",
            "你是严谨的代码评审者。检查正确性、边界条件、安全性、性能与可读性，按严重程度分级列出问题，并给出具体修改建议而非泛泛而谈。",
        ),
        agent(
            "researcher",
            "研究员 Researcher",
            "调研分析",
            "📚",
            "#4ab3f7",
            "收集与核实资料，梳理事实与来源，形成结构化结论。",
            "你是细致的研究员。围绕问题系统检索与交叉验证信息，区分事实与推测，标注来源，输出结构化、可追溯的调研结论。",
        ),
        agent(
            "writer",
            "撰稿 Writer",
            "内容撰写",
            "✍️",
            "#fc5c65",
            "将调研与方案转化为清晰、准确、面向受众的文稿。",
            "你是专业撰稿人。根据受众与目标组织内容，做到结构清晰、表达准确、详略得当，并保持术语与风格一致。",
        ),
    ]
}

const FULLSTACK_ORG_SPEC: &str = r#"# 全栈小队 org_spec

## 角色
- architect：拆解需求、产出方案与接口契约。
- coder：按方案实现并自测。
- reviewer：评审实现，提出修改意见直至达标。

## 规则
- 由协调者按波次（waves）分派 todo：先设计、再实现、后评审。
- 每个成员只在自己职责范围内行动，产出需可被下一环节直接使用。
- reviewer 发现的问题以新 todo 形式回流给 coder，闭环后方可完成。

## 集成
- 最终交付由协调者汇总：方案、实现说明、评审结论。
"#;

const RESEARCH_ORG_SPEC: &str = r#"# 研究二人组 org_spec

## 角色
- researcher：检索、核实并结构化关键事实与来源。
- writer：基于调研结论撰写面向受众的成稿。

## 规则
- sequential 工作流：researcher 先完成调研并交付结构化要点，writer 再据此成文。
- writer 如发现信息缺口，回流问题给 researcher 补充。

## 集成
- 协调者交付：调研要点 + 终稿，并附主要来源。
"#;

fn builtin_teams() -> Vec<TeamManifest> {
    vec![
        TeamManifest {
            id: "fullstack-squad".to_string(),
            name: "全栈小队 Fullstack Squad".to_string(),
            description: "架构师 + 工程师 + 评审的端到端研发小队。".to_string(),
            mode: "swarm".to_string(),
            org_spec: FULLSTACK_ORG_SPEC.to_string(),
            members: vec![
                "architect".to_string(),
                "coder".to_string(),
                "reviewer".to_string(),
            ],
            workflow_hint: "waves".to_string(),
            workflow: None,
            task_timeout_secs: 0,
        },
        TeamManifest {
            id: "research-duo".to_string(),
            name: "研究二人组 Research Duo".to_string(),
            description: "研究员 + 撰稿的调研到成文小队。".to_string(),
            mode: "swarm".to_string(),
            org_spec: RESEARCH_ORG_SPEC.to_string(),
            members: vec!["researcher".to_string(), "writer".to_string()],
            workflow_hint: "sequential".to_string(),
            workflow: None,
            task_timeout_secs: 0,
        },
        TeamManifest {
            id: "code-review-loop".to_string(),
            name: "代码评审循环 Code Review Loop".to_string(),
            description: "工作流示例：编码 → 评审 → 不通过则回炉重写，最多 3 轮。".to_string(),
            mode: "workflow".to_string(),
            org_spec: String::new(),
            members: vec!["coder".to_string(), "reviewer".to_string()],
            workflow_hint: "review".to_string(),
            workflow: code_review_workflow(),
            task_timeout_secs: 0,
        },
    ]
}

fn write_if_absent(path: &Path, contents: &str) {
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            warn!("seed: cannot create {}: {}", parent.display(), e);
            return;
        }
    }
    if let Err(e) = std::fs::write(path, contents) {
        warn!("seed: cannot write {}: {}", path.display(), e);
    }
}

/// Seed built-in agent/team packs on first run. Idempotent and non-destructive.
pub fn seed_builtin_packs(app: &AppHandle) {
    let config_dir = match resolve_global_config_dir(app) {
        Ok(d) => d,
        Err(e) => {
            warn!("seed: cannot resolve config dir: {}", e);
            return;
        }
    };
    let sentinel = config_dir.join(SEED_SENTINEL);
    if sentinel.exists() {
        return;
    }

    let agents_dir = config_dir.join("agents");
    for manifest in builtin_agents() {
        let target = agents_dir.join(safe_id(&manifest.id)).join("agent.json");
        match serde_json::to_string_pretty(&manifest) {
            Ok(json) => write_if_absent(&target, &json),
            Err(e) => warn!("seed: serialize agent {} failed: {}", manifest.id, e),
        }
    }

    let teams_dir = config_dir.join("teams");
    for manifest in builtin_teams() {
        let target = teams_dir.join(safe_id(&manifest.id)).join("team.json");
        match serde_json::to_string_pretty(&manifest) {
            Ok(json) => write_if_absent(&target, &json),
            Err(e) => warn!("seed: serialize team {} failed: {}", manifest.id, e),
        }
    }

    if let Err(e) = std::fs::create_dir_all(&config_dir) {
        warn!("seed: cannot create config dir: {}", e);
        return;
    }
    if let Err(e) = std::fs::write(&sentinel, b"1") {
        warn!("seed: cannot write sentinel: {}", e);
    } else {
        info!("seed: installed built-in agent/team packs");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_workflow_team_is_valid() {
        let graph = code_review_workflow().expect("workflow JSON deserializes");
        graph.validate().expect("built-in workflow graph is valid");
        // Loop body + exit edges and agent ids are present.
        assert_eq!(graph.entry, "start");
        assert!(graph.nodes.iter().any(|n| n.kind == "loop"));
        assert!(graph.nodes.iter().filter(|n| n.kind == "agent").all(|n| n
            .agent_id
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)));
    }
}
