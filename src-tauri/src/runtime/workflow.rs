//! Workflow driver — deterministic, coordinator-free multi-agent execution.
//!
//! Walks a [`WorkflowGraph`] one node at a time, threading a shared blackboard
//! between agent steps. Agent nodes run through the same in-process
//! [`DesktopInProcessSubagentRuntime`] swarm Koi use; branch nodes pick an edge
//! via an LLM judge or a blackboard expression; loop nodes gate a bounded
//! back-edge. No Piscis coordinator is involved — the driver itself is the only
//! thing advancing the run, so it cannot deadlock or stall on dispatch.
//!
//! The driver runs in a background `tokio` task. It never holds the project DB
//! lock across an agent turn (the turn re-acquires it), and it persists run
//! state + emits an `agentz:workflow-event` after every node.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use piscis_core::host::{KoiTurnExit, KoiTurnHandle, KoiTurnRequest, SubagentRuntime};

use crate::commands::agents::safe_id;
use crate::commands::data_scope::open_project_kernel_state;
use crate::commands::workflow::{
    load_run, save_run, BranchEvaluator, StepRecord, WorkflowRun,
};
use crate::runtime::koi::DesktopInProcessSubagentRuntime;

const WORKFLOW_EVENT_CHANNEL: &str = "agentz:workflow-event";

/// Result of driving an agent node through its retry/skip policy.
enum AgentOutcome {
    Ok(String),
    Skipped(String),
}

fn cancel_registry() -> &'static Mutex<HashSet<String>> {
    static REG: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The Koi turn currently in flight for a run, so `workflow_cancel` can abort it
/// mid-turn instead of only between nodes.
type ActiveTurn = (Arc<DesktopInProcessSubagentRuntime>, KoiTurnHandle);

fn active_turns() -> &'static Mutex<HashMap<String, ActiveTurn>> {
    static REG: OnceLock<Mutex<HashMap<String, ActiveTurn>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_active(run_id: &str, turn: ActiveTurn) {
    if let Ok(mut map) = active_turns().lock() {
        map.insert(run_id.to_string(), turn);
    }
}

fn unregister_active(run_id: &str) {
    if let Ok(mut map) = active_turns().lock() {
        map.remove(run_id);
    }
}

pub fn request_cancel(run_id: &str) {
    if let Ok(mut set) = cancel_registry().lock() {
        set.insert(run_id.to_string());
    }
}

/// Cancel the in-flight Koi turn for a run (if any). Pairs with
/// [`request_cancel`] so a cancel aborts both the current step and the loop.
pub async fn cancel_active_turn(run_id: &str) {
    let active = active_turns().lock().ok().and_then(|m| m.get(run_id).cloned());
    if let Some((runtime, handle)) = active {
        let _ = runtime.cancel_koi_turn(&handle).await;
    }
}

fn is_cancelled(run_id: &str) -> bool {
    cancel_registry()
        .lock()
        .map(|s| s.contains(run_id))
        .unwrap_or(false)
}

fn clear_cancel(run_id: &str) {
    if let Ok(mut set) = cancel_registry().lock() {
        set.remove(run_id);
    }
}

/// Spawn the background driver for a run. Safe to call again after a `human`
/// pause (it picks up from the persisted cursor).
pub fn spawn_driver(app: AppHandle, run_id: String) {
    tokio::spawn(async move {
        if let Err(e) = drive(app.clone(), &run_id).await {
            tracing::warn!("workflow run {} driver error: {}", run_id, e);
            if let Ok(mut run) = load_run(&app, &run_id) {
                run.status = "failed".to_string();
                run.error = Some(e);
                run.updated_at = now();
                let _ = save_run(&app, &run);
                emit(&app, &run, "failed", None, None);
            }
        }
    });
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

async fn drive(app: AppHandle, run_id: &str) -> Result<(), String> {
    // One runtime instance per run so an in-flight turn can be cancelled.
    let runtime = Arc::new(DesktopInProcessSubagentRuntime::new(app.clone()));
    loop {
        let mut run = load_run(&app, run_id)?;
        if run.status != "running" {
            return Ok(());
        }
        if is_cancelled(run_id) {
            clear_cancel(run_id);
            run.status = "cancelled".to_string();
            run.updated_at = now();
            save_run(&app, &run)?;
            emit(&app, &run, "cancelled", None, None);
            return Ok(());
        }
        let Some(cursor) = run.cursor.clone() else {
            finish(&app, &mut run, "completed", None)?;
            return Ok(());
        };
        run.steps += 1;
        if run.steps > run.graph.max_total_steps {
            run.error = Some(format!(
                "step budget exceeded ({} > {})",
                run.steps, run.graph.max_total_steps
            ));
            finish(&app, &mut run, "failed", None)?;
            return Ok(());
        }

        let node = match run.graph.node(&cursor) {
            Some(n) => n.clone(),
            None => {
                run.error = Some(format!("node '{}' not found", cursor));
                finish(&app, &mut run, "failed", None)?;
                return Ok(());
            }
        };

        match node.kind.as_str() {
            "start" => {
                run.cursor = run.graph.next_of(&cursor);
                record(&mut run, &node, None, Some("start".into()));
                save_run(&app, &run)?;
                emit(&app, &run, "node", Some(&cursor), None);
            }
            "end" => {
                finish(&app, &mut run, "completed", Some(&cursor))?;
                return Ok(());
            }
            "human" => {
                run.status = "waiting_human".to_string();
                run.updated_at = now();
                save_run(&app, &run)?;
                emit(&app, &run, "waiting_human", Some(&cursor), None);
                return Ok(());
            }
            "agent" => {
                // Node-level fault tolerance: retry up to `max_retries`, then
                // honor `on_error` (fail = abort run, skip = record + advance).
                let mut attempt = 0u32;
                let outcome: AgentOutcome = loop {
                    match run_agent_node(&app, &runtime, &mut run, &node).await {
                        Ok(s) => break AgentOutcome::Ok(s),
                        Err(e) => {
                            if is_cancelled(run_id) {
                                clear_cancel(run_id);
                                run.status = "cancelled".to_string();
                                finish(&app, &mut run, "cancelled", Some(&cursor))?;
                                return Ok(());
                            }
                            if attempt < node.max_retries {
                                attempt += 1;
                                emit(
                                    &app,
                                    &run,
                                    "retry",
                                    Some(&cursor),
                                    Some(&format!("attempt {}/{}: {}", attempt, node.max_retries, e)),
                                );
                                tokio::time::sleep(Duration::from_millis(400)).await;
                                continue;
                            }
                            if node.on_error.as_deref() == Some("skip") {
                                break AgentOutcome::Skipped(e);
                            }
                            return Err(e);
                        }
                    }
                };
                run.cursor = run.graph.next_of(&cursor);
                match outcome {
                    AgentOutcome::Ok(summary) => {
                        record(&mut run, &node, Some(summary.clone()), None);
                        save_run(&app, &run)?;
                        emit(&app, &run, "node", Some(&cursor), Some(&summary));
                    }
                    AgentOutcome::Skipped(err) => {
                        let key = node
                            .output_key
                            .clone()
                            .filter(|k| !k.trim().is_empty())
                            .unwrap_or_else(|| node.id.clone());
                        run.blackboard.insert(key, Value::String(String::new()));
                        let note = format!("skipped after error: {}", err);
                        record(&mut run, &node, Some(note.clone()), Some("skipped".into()));
                        save_run(&app, &run)?;
                        emit(&app, &run, "skipped", Some(&cursor), Some(&note));
                    }
                }
            }
            "branch" => {
                let label = match evaluate_branch(&app, &runtime, &mut run, &node).await {
                    Ok(l) => l,
                    Err(e) => {
                        if is_cancelled(run_id) {
                            clear_cancel(run_id);
                            finish(&app, &mut run, "cancelled", Some(&cursor))?;
                            return Ok(());
                        }
                        return Err(e);
                    }
                };
                let target = node
                    .cases
                    .iter()
                    .find(|c| c.label.eq_ignore_ascii_case(&label))
                    .map(|c| c.to.clone())
                    .or_else(|| node.default_to.clone());
                if target.is_none() {
                    run.error = Some(format!(
                        "branch '{}' produced label '{}' with no matching case",
                        node.id, label
                    ));
                    finish(&app, &mut run, "failed", None)?;
                    return Ok(());
                }
                run.cursor = target;
                record(&mut run, &node, None, Some(label.clone()));
                save_run(&app, &run)?;
                emit(&app, &run, "branch", Some(&cursor), Some(&label));
            }
            "loop" => {
                let count = run
                    .iter_counts
                    .get(&node.id)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let guard = node.guard.clone().unwrap_or(crate::commands::workflow::LoopGuard {
                    max_iterations: 5,
                    exit_when: None,
                });
                let exit_early = guard
                    .exit_when
                    .as_deref()
                    .map(|e| eval_expr(e, &run))
                    .unwrap_or(false);
                if !exit_early && count < guard.max_iterations && node.body_to.is_some() {
                    run.iter_counts
                        .insert(node.id.clone(), json!(count + 1));
                    run.cursor = node.body_to.clone();
                    record(&mut run, &node, None, Some(format!("iteration {}", count + 1)));
                    save_run(&app, &run)?;
                    emit(&app, &run, "loop", Some(&cursor), Some(&format!("iter {}", count + 1)));
                } else {
                    // Exit edge = the outgoing edge that is NOT the loop body.
                    run.cursor = run
                        .graph
                        .edges
                        .iter()
                        .find(|e| {
                            e.from == cursor && node.body_to.as_deref() != Some(e.to.as_str())
                        })
                        .map(|e| e.to.clone());
                    record(&mut run, &node, None, Some("loop exit".into()));
                    save_run(&app, &run)?;
                    emit(&app, &run, "loop_exit", Some(&cursor), None);
                }
            }
            other => {
                run.error = Some(format!("unknown node kind '{}'", other));
                finish(&app, &mut run, "failed", None)?;
                return Ok(());
            }
        }

        // Yield so cancellation / UI updates interleave between nodes.
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn finish(
    app: &AppHandle,
    run: &mut WorkflowRun,
    status: &str,
    node_id: Option<&str>,
) -> Result<(), String> {
    clear_cancel(&run.run_id);
    run.status = status.to_string();
    run.cursor = None;
    run.updated_at = now();
    save_run(app, run)?;
    emit(app, run, status, node_id, None);
    Ok(())
}

fn record(run: &mut WorkflowRun, node: &crate::commands::workflow::WorkflowNode, summary: Option<String>, label: Option<String>) {
    run.history.push(StepRecord {
        node_id: node.id.clone(),
        kind: node.kind.clone(),
        agent_id: node.agent_id.clone(),
        output_key: node.output_key.clone(),
        label,
        summary,
        at: now(),
    });
}

fn emit(app: &AppHandle, run: &WorkflowRun, kind: &str, node_id: Option<&str>, summary: Option<&str>) {
    let _ = app.emit(
        WORKFLOW_EVENT_CHANNEL,
        json!({
            "runId": run.run_id,
            "poolId": run.pool_id,
            "kind": kind,
            "nodeId": node_id,
            "status": run.status,
            "summary": summary,
            "blackboard": Value::Object(run.blackboard.clone()),
        }),
    );
}

/// Run an agent node: resolve its koi, assemble context, run one turn, capture
/// the output into the blackboard, and post the result to the pool transcript.
async fn run_agent_node(
    app: &AppHandle,
    runtime: &Arc<DesktopInProcessSubagentRuntime>,
    run: &mut WorkflowRun,
    node: &crate::commands::workflow::WorkflowNode,
) -> Result<String, String> {
    let agent_id = node
        .agent_id
        .clone()
        .ok_or_else(|| format!("agent node '{}' has no agent_id", node.id))?;
    let slug = safe_id(&agent_id);

    let (db, _settings) = open_project_kernel_state(app, &run.project_dir)?;
    let (koi_id, koi_system_prompt) = {
        let db = db.lock().await;
        let koi = db
            .find_koi_by_name(&slug)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no koi for agent '{}'", agent_id))?;
        (koi.id, koi.system_prompt)
    };

    let user_prompt = render_template(
        node.prompt_template.as_deref().unwrap_or("{{goal}}"),
        run,
    );
    let extra_context = assemble_step_context(run, node);

    let request = KoiTurnRequest {
        pool_id: run.pool_id.clone(),
        koi_id: koi_id.clone(),
        session_id: format!("{}::{}", run.run_id, node.id),
        todo_id: None,
        system_prompt: koi_system_prompt,
        user_prompt,
        workspace: Some(run.project_dir.clone()),
        task_timeout_secs: None,
        extra_tool_profile: Vec::new(),
        extra_system_context: Some(extra_context),
    };

    let handle = runtime
        .spawn_koi_turn(request)
        .await
        .map_err(|e| e.to_string())?;
    register_active(&run.run_id, (runtime.clone(), handle.clone()));
    let wait = runtime.wait_koi_turn(&handle).await;
    unregister_active(&run.run_id);
    let outcome = wait.map_err(|e| e.to_string())?;

    if outcome.exit_kind != KoiTurnExit::Completed {
        let err = outcome
            .error
            .unwrap_or_else(|| format!("{:?}", outcome.exit_kind));
        return Err(format!("agent '{}' turn failed: {}", agent_id, err));
    }

    let output = outcome.response_text;
    let key = node
        .output_key
        .clone()
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| node.id.clone());
    run.blackboard.insert(key, Value::String(output.clone()));

    // Persist the step to the pool transcript for the collaboration board.
    {
        let db = db.lock().await;
        let _ = db.insert_pool_message_ext(
            &run.pool_id,
            &koi_id,
            &output,
            "result",
            "{}",
            None,
            None,
            Some("workflow_step"),
        );
    }

    Ok(truncate(&output, 280))
}

/// Decide a branch label: either an LLM judge turn or a blackboard expression.
async fn evaluate_branch(
    app: &AppHandle,
    runtime: &Arc<DesktopInProcessSubagentRuntime>,
    run: &mut WorkflowRun,
    node: &crate::commands::workflow::WorkflowNode,
) -> Result<String, String> {
    let evaluator = node
        .evaluator
        .clone()
        .ok_or_else(|| format!("branch node '{}' has no evaluator", node.id))?;
    match evaluator {
        BranchEvaluator::Expr { expr } => Ok(if eval_expr(&expr, run) {
            "true".to_string()
        } else {
            "false".to_string()
        }),
        BranchEvaluator::Llm {
            classifier_prompt,
            labels,
            agent_id,
        } => {
            let judge_slug = agent_id
                .map(|a| safe_id(&a))
                .filter(|s| !s.is_empty())
                .or_else(|| run.history.iter().rev().find_map(|h| h.agent_id.clone()).map(|a| safe_id(&a)));

            let (db, _settings) = open_project_kernel_state(app, &run.project_dir)?;
            let (koi_id, koi_system_prompt) = {
                let db = db.lock().await;
                let koi = match judge_slug
                    .as_deref()
                    .and_then(|s| db.find_koi_by_name(s).ok().flatten())
                {
                    Some(k) => k,
                    None => db
                        .list_pool_member_ids(&run.pool_id)
                        .ok()
                        .and_then(|ids| ids.into_iter().next())
                        .and_then(|id| db.get_koi(&id).ok().flatten())
                        .ok_or_else(|| "branch judge: no koi available".to_string())?,
                };
                (koi.id, koi.system_prompt)
            };

            let label_list = labels.join(" | ");
            let user_prompt = format!(
                "{}\n\nRespond with EXACTLY one of these labels and nothing else: {}",
                render_template(&classifier_prompt, run),
                label_list
            );
            let extra_context = assemble_step_context(run, node);

            let request = KoiTurnRequest {
                pool_id: run.pool_id.clone(),
                koi_id: koi_id.clone(),
                session_id: format!("{}::{}::judge", run.run_id, node.id),
                todo_id: None,
                system_prompt: koi_system_prompt,
                user_prompt,
                workspace: Some(run.project_dir.clone()),
                task_timeout_secs: None,
                extra_tool_profile: Vec::new(),
                extra_system_context: Some(extra_context),
            };
            let handle = runtime
                .spawn_koi_turn(request)
                .await
                .map_err(|e| e.to_string())?;
            register_active(&run.run_id, (runtime.clone(), handle.clone()));
            let wait = runtime.wait_koi_turn(&handle).await;
            unregister_active(&run.run_id);
            let outcome = wait.map_err(|e| e.to_string())?;
            let text = outcome.response_text.to_lowercase();
            // Pick the first declared label that appears in the response.
            let chosen = labels
                .iter()
                .find(|l| text.contains(&l.to_lowercase()))
                .cloned()
                .unwrap_or_else(|| labels.first().cloned().unwrap_or_else(|| "default".into()));
            Ok(chosen)
        }
    }
}

/// Assemble the per-step extra system context: the run goal + the latest
/// upstream outputs the step is likely to need. This is the workflow analogue
/// of swarm's org_spec injection.
fn assemble_step_context(run: &WorkflowRun, node: &crate::commands::workflow::WorkflowNode) -> String {
    let mut out = String::new();
    out.push_str("## Workflow Context\n\n");
    out.push_str(&format!("You are executing step `{}` of team `{}`.\n", node.id, run.team_name));
    if let Some(goal) = run.blackboard.get("goal").and_then(|v| v.as_str()) {
        out.push_str(&format!("\n### Overall Goal\n{}\n", goal));
    }
    // Recent upstream outputs (skip the goal; cap length).
    let mut shared = String::new();
    for (k, v) in &run.blackboard {
        if k == "goal" {
            continue;
        }
        if let Some(s) = v.as_str() {
            shared.push_str(&format!("\n#### {}\n{}\n", k, truncate(s, 1200)));
        }
    }
    if !shared.is_empty() {
        out.push_str("\n### Prior Step Outputs\n");
        out.push_str(&shared);
    }
    out.push_str(
        "\nProduce a focused result for your step. Do not restate the whole context; \
         hand off a self-contained output the next step can build on.\n",
    );
    out
}

/// `{{key}}` substitution from the blackboard. `{{goal}}` is always available.
fn render_template(tmpl: &str, run: &WorkflowRun) -> String {
    let mut out = tmpl.to_string();
    for (k, v) in &run.blackboard {
        if let Some(s) = v.as_str() {
            out = out.replace(&format!("{{{{{}}}}}", k), s);
        }
    }
    out
}

/// Tiny expression evaluator over the blackboard.
///
/// Supported forms (case-insensitive operators):
/// - `KEY == value` / `KEY != value`
/// - `KEY contains value` / `KEY !contains value`
/// - `KEY` (truthy: present and not empty/false/0/no)
fn eval_expr(expr: &str, run: &WorkflowRun) -> bool {
    let expr = expr.trim();
    let get = |key: &str| -> String {
        run.blackboard
            .get(key.trim())
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| Some(v.to_string())))
            .unwrap_or_default()
    };
    let strip = |s: &str| s.trim().trim_matches('"').trim_matches('\'').to_string();

    for (op, neg) in [("!contains", true), ("contains", false)] {
        if let Some(idx) = expr.to_lowercase().find(op) {
            let key = &expr[..idx];
            let val = &expr[idx + op.len()..];
            let hay = get(key).to_lowercase();
            let needle = strip(val).to_lowercase();
            let hit = hay.contains(&needle);
            return if neg { !hit } else { hit };
        }
    }
    if let Some(idx) = expr.find("==") {
        return get(&expr[..idx]).trim().eq_ignore_ascii_case(&strip(&expr[idx + 2..]));
    }
    if let Some(idx) = expr.find("!=") {
        return !get(&expr[..idx]).trim().eq_ignore_ascii_case(&strip(&expr[idx + 2..]));
    }
    // Bare key truthiness.
    let v = get(expr).trim().to_lowercase();
    !(v.is_empty() || v == "false" || v == "0" || v == "no")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}
