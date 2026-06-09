//! Plan mode entry/exit and brainstorming survey cards (`plan_mode_ui` tool).

use async_trait::async_trait;
use piscis_kernel::agent::messages::AgentEvent;
use piscis_kernel::agent::plan_doc::default_plan_rel_path;
use piscis_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::chat::CHAT_EVENT;
use crate::state::AppState;

use super::chat_ui::render_interactive_response_result;

const SUGGEST_TIMEOUT_SECS: u64 = 30;
const BRAINSTORM_TIMEOUT_SECS: u64 = 300;

pub struct PlanModeUiTool {
    pub app: AppHandle,
    pub loop_halt: Arc<std::sync::atomic::AtomicBool>,
}

fn emit_event(app: &AppHandle, session_id: &str, event: AgentEvent) {
    if let Ok(payload) = serde_json::to_value(&event) {
        let _ = app.emit(
            CHAT_EVENT,
            json!({ "sessionId": session_id, "channel": "agent_event", "payload": payload }),
        );
    }
}

fn suggest_enter_ui(message: &str) -> Value {
    json!({
        "protocol_version": "2",
        "kind": "plan_mode_suggest",
        "title": "建议进入 Plan 模式",
        "description": message,
        "data": { "decision": "continue_agent" },
        "blocks": [
            {
                "type": "text",
                "content": "该任务较复杂，建议先进入 **Plan 模式** 澄清需求并编写执行计划。30 秒内未选择将按 Agent 模式继续。"
            },
            {
                "type": "radio",
                "id": "decision",
                "label": "如何选择？",
                "options": [
                    { "value": "enter_plan", "label": "进入 Plan 模式（推荐）" },
                    { "value": "continue_agent", "label": "继续 Agent 模式直接执行" }
                ],
                "default": "continue_agent"
            },
            {
                "type": "actions",
                "buttons": [
                    { "id": "submit", "label": "确认", "variant": "primary", "emit": "submit" }
                ]
            }
        ]
    })
}

fn plan_ready_ui(plan_path: &str, summary: &str) -> Value {
    json!({
        "protocol_version": "2",
        "kind": "plan_mode_build",
        "title": "计划已就绪",
        "description": summary,
        "data": { "plan_path": plan_path },
        "blocks": [
            {
                "type": "text",
                "content": format!("执行计划已写入 `{plan_path}`。点击下方 **Build** 退出 Plan 模式并开始执行。")
            },
            {
                "type": "actions",
                "buttons": [
                    {
                        "id": "build",
                        "label": "Build — 开始执行",
                        "variant": "primary",
                        "emit": "action",
                        "value": "build"
                    }
                ]
            }
        ]
    })
}

fn brainstorm_ui(title: &str, intro: &str, questions: &[Value]) -> Value {
    let mut blocks: Vec<Value> = vec![
        json!({ "type": "text", "content": intro }),
        json!({ "type": "divider" }),
    ];
    for q in questions {
        blocks.push(q.clone());
    }
    blocks.push(json!({
        "type": "actions",
        "buttons": [
            { "id": "submit", "label": "提交回答", "variant": "primary", "emit": "submit" }
        ]
    }));
    json!({
        "protocol_version": "2",
        "kind": "plan_mode_brainstorm",
        "title": title,
        "description": "请回答以下问题以澄清需求（每题尽量选一项，也可填写自定义说明）",
        "data": {},
        "blocks": blocks
    })
}

/// Build a radio + optional custom text block for one brainstorm question.
pub fn brainstorm_question_block(id: &str, prompt: &str, options: &[(&str, &str)]) -> Value {
    let mut opts: Vec<Value> = options
        .iter()
        .map(|(v, l)| json!({ "value": v, "label": l }))
        .collect();
    opts.push(json!({ "value": "__custom__", "label": "其他（自定义）" }));
    json!({
        "type": "section",
        "label": prompt,
        "blocks": [
            {
                "type": "radio",
                "id": id,
                "label": "请选择",
                "options": opts,
                "default": options.first().map(|(v, _)| *v).unwrap_or("")
            },
            {
                "type": "text_input",
                "id": format!("{id}_custom"),
                "label": "补充说明（选「其他」或需要额外细节时填写）",
                "placeholder": "可选",
                "multiline": true,
                "rows": 2
            }
        ]
    })
}

async fn wait_interactive(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    ui_def: Value,
    timeout_secs: u64,
) -> Result<Value, ToolResult> {
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<AppState>();
        let mut map = state.interactive_responses.lock().await;
        map.insert(request_id.to_string(), resp_tx);
    }
    emit_event(
        app,
        session_id,
        AgentEvent::InteractiveUi {
            request_id: request_id.to_string(),
            ui_definition: ui_def,
        },
    );
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), resp_rx).await {
        Ok(Ok(values)) => Ok(values),
        Ok(Err(_)) => Err(ToolResult::err(
            "Plan 模式 UI 响应通道已关闭（用户可能已离开页面）。",
        )),
        Err(_) => {
            let state = app.state::<AppState>();
            let mut map = state.interactive_responses.lock().await;
            map.remove(request_id);
            Err(ToolResult::err(format!(
                "Plan 模式 UI 在 {timeout_secs} 秒内无响应（视为超时/拒绝）。"
            )))
        }
    }
}

#[async_trait]
impl Tool for PlanModeUiTool {
    fn name(&self) -> &str {
        "plan_mode_ui"
    }

    fn description(&self) -> &str {
        "Plan mode workflow UI. Actions:\n\
         - `suggest_enter` (Agent mode): ask user to enter Plan mode; 30s timeout → continue Agent.\n\
         - `brainstorm` (Plan mode): multi-question survey via chat_ui-style card; blocks until submit.\n\
         - `plan_ready` (Plan mode): show Build button after plan_write; halts agent loop until user clicks Build in UI.\n\
         For brainstorm, pass `questions` array — each item: { id, prompt, options: [{value, label}, ...] }."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["suggest_enter", "brainstorm", "plan_ready"]
                },
                "message": { "type": "string", "description": "Intro text for suggest_enter or plan_ready summary" },
                "title": { "type": "string", "description": "Brainstorm card title" },
                "intro": { "type": "string", "description": "Brainstorm intro paragraph" },
                "plan_path": { "type": "string", "description": "Relative plan file path for plan_ready" },
                "questions": {
                    "type": "array",
                    "description": "Brainstorm questions",
                    "items": {
                        "type": "object",
                        "required": ["id", "prompt", "options"],
                        "properties": {
                            "id": { "type": "string" },
                            "prompt": { "type": "string" },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "required": ["value", "label"],
                                    "properties": {
                                        "value": { "type": "string" },
                                        "label": { "type": "string" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let action = input["action"].as_str().unwrap_or("");
        let request_id = ctx
            .tool_use_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        match action {
            "suggest_enter" => {
                let message = input["message"]
                    .as_str()
                    .unwrap_or("该任务涉及多步改动或存在多种实现方案，建议先规划再执行。");
                let ui = suggest_enter_ui(message);
                match wait_interactive(
                    &self.app,
                    &ctx.session_id,
                    &request_id,
                    ui,
                    SUGGEST_TIMEOUT_SECS,
                )
                .await
                {
                    Ok(values) => {
                        let decision = values
                            .get("decision")
                            .and_then(|v| v.as_str())
                            .unwrap_or("continue_agent");
                        let outcome = if decision == "enter_plan" {
                            "enter_plan"
                        } else {
                            "continue_agent"
                        };
                        Ok(ToolResult::ok(format!(
                            "PLAN_MODE_UI_RESULT:\n{}\n\n\
                             decision={outcome}. \
                             若 enter_plan：告知用户已切换至 Plan 模式，开始头脑风暴澄清需求（使用 brainstorm），\
                             问清后再 plan_write。若 continue_agent：直接按 Agent 模式执行，勿再建议 Plan。",
                            serde_json::to_string_pretty(&values).unwrap_or_default()
                        )))
                    }
                    Err(e) => Ok(ToolResult::ok(format!(
                        "PLAN_MODE_UI_RESULT:\n{{\"decision\":\"timeout\",\"reason\":\"{reason}\"}}\n\n\
                         decision=continue_agent. 用户未在 {secs}s 内确认，按 Agent 模式继续执行，勿再调用 suggest_enter。",
                        reason = e.content,
                        secs = SUGGEST_TIMEOUT_SECS
                    ))),
                }
            }
            "brainstorm" => {
                let title = input["title"].as_str().unwrap_or("需求澄清");
                let intro = input["intro"].as_str().unwrap_or(
                    "在编写计划前，请确认以下问题。可一次回答多题；若有不确定处请选「其他」并填写说明。",
                );
                let questions_raw = input["questions"].as_array().cloned().unwrap_or_default();
                if questions_raw.is_empty() {
                    return Ok(ToolResult::err(
                        "brainstorm 需要至少 1 个问题（questions 数组）。",
                    ));
                }
                let mut blocks: Vec<Value> = Vec::new();
                for q in &questions_raw {
                    let id = q["id"].as_str().unwrap_or("q");
                    let prompt = q["prompt"].as_str().unwrap_or("问题");
                    let opts: Vec<(&str, &str)> = q["options"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|o| {
                                    Some((o["value"].as_str()?, o["label"].as_str().unwrap_or("")))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if opts.is_empty() {
                        blocks.push(json!({
                            "type": "section",
                            "label": prompt,
                            "blocks": [{
                                "type": "text_input",
                                "id": id,
                                "label": "你的回答",
                                "multiline": true,
                                "rows": 3
                            }]
                        }));
                    } else {
                        let owned: Vec<(String, String)> = opts
                            .iter()
                            .map(|(v, l)| (v.to_string(), l.to_string()))
                            .collect();
                        let refs: Vec<(&str, &str)> = owned
                            .iter()
                            .map(|(v, l)| (v.as_str(), l.as_str()))
                            .collect();
                        blocks.push(brainstorm_question_block(id, prompt, &refs));
                    }
                }
                let ui = brainstorm_ui(title, intro, &blocks);
                match wait_interactive(
                    &self.app,
                    &ctx.session_id,
                    &request_id,
                    ui,
                    BRAINSTORM_TIMEOUT_SECS,
                )
                .await
                {
                    Ok(values) => Ok(ToolResult::ok(render_interactive_response_result(&values))),
                    Err(e) => Ok(e),
                }
            }
            "plan_ready" => {
                let plan_path = input["plan_path"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| default_plan_rel_path(&ctx.session_id));
                let summary = input["message"]
                    .as_str()
                    .unwrap_or("计划文件已写入，请确认后开始执行。");
                let ui = plan_ready_ui(&plan_path, summary);
                emit_event(
                    &self.app,
                    &ctx.session_id,
                    AgentEvent::InteractiveUi {
                        request_id: request_id.clone(),
                        ui_definition: ui,
                    },
                );
                self.loop_halt.store(true, Ordering::SeqCst);
                Ok(ToolResult::ok(format!(
                    "PLAN_READY_UI_SHOWN: plan_path={plan_path}. \
                     Build 按钮已展示，agent 循环已暂停。用户点击 Build 后将切换到 Agent 模式执行计划。\
                     请勿继续调用工具或输出更多内容。"
                )))
            }
            other => Ok(ToolResult::err(format!(
                "未知 action '{other}'，必须是 suggest_enter / brainstorm / plan_ready"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_ui_has_kind_and_decision_field() {
        let ui = suggest_enter_ui("test");
        assert_eq!(ui["kind"], "plan_mode_suggest");
        assert!(ui["blocks"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn plan_ready_ui_has_build_button() {
        let ui = plan_ready_ui(".agentz/plans/x.md", "done");
        assert_eq!(ui["kind"], "plan_mode_build");
        assert_eq!(ui["data"]["plan_path"], ".agentz/plans/x.md");
    }
}
