//! Workflow teams (no-coordinator mode).
//!
//! A `workflow` team executes a deterministic graph of agent steps instead of
//! the swarm/pool coordinator. Agents run sequentially (one node at a time);
//! the graph supports branching (LLM- or expression-based) and bounded loops.
//! There is no Piscis coordinator — a [`runtime::workflow`] driver walks the
//! graph, threading a shared blackboard between steps, and runs each agent node
//! through the same in-process [`SubagentRuntime`] that swarm Koi use.
//!
//! Run state (cursor + blackboard + history) is persisted as JSON under
//! `{config}/workflow-runs/<run_id>.json`. For visualisation we reuse a kernel
//! `pool_session` (members + messages) so the collaboration board can render
//! the transcript; live progress streams over `agentz:workflow-event`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::commands::agents::{safe_id, sync_agents_to_kois};
use crate::commands::data_scope::{open_project_kernel_state, resolve_global_config_dir};
use crate::commands::teams::TeamManifest;

// ─── Graph schema ────────────────────────────────────────────────────────────

fn default_max_steps() -> u32 {
    100
}

/// A deterministic workflow graph. Non-branch/loop nodes follow their single
/// outgoing edge; branch nodes pick a case; loop nodes gate a back-edge body.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkflowGraph {
    /// Node id execution starts at (usually the `start` node).
    #[serde(default)]
    pub entry: String,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    /// Global circuit breaker: abort the run after this many node visits.
    #[serde(default = "default_max_steps")]
    pub max_total_steps: u32,
}

impl WorkflowGraph {
    pub fn node(&self, id: &str) -> Option<&WorkflowNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// The unconditional successor of a node (first edge whose `from` matches).
    pub fn next_of(&self, id: &str) -> Option<String> {
        self.edges
            .iter()
            .find(|e| e.from == id)
            .map(|e| e.to.clone())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.entry.trim().is_empty() {
            return Err("workflow has no entry node".into());
        }
        if self.node(&self.entry).is_none() {
            return Err(format!("entry node '{}' not found", self.entry));
        }
        for n in &self.nodes {
            if n.kind == "agent" && n.agent_id.as_deref().unwrap_or("").trim().is_empty() {
                return Err(format!("agent node '{}' has no agent_id", n.id));
            }
        }
        Ok(())
    }

    /// Derive loop `body_to` from edges labelled `body` (matches WorkflowDesigner).
    pub fn normalize_loop_nodes(&mut self) {
        for node in &mut self.nodes {
            if node.kind != "loop" {
                continue;
            }
            if node.body_to.as_deref().unwrap_or("").trim().is_empty() {
                node.body_to = self
                    .edges
                    .iter()
                    .find(|e| {
                        e.from == node.id
                            && e.label
                                .as_deref()
                                .map(|l| l.trim().eq_ignore_ascii_case("body"))
                                .unwrap_or(false)
                    })
                    .map(|e| e.to.clone());
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    /// `start` | `end` | `agent` | `branch` | `loop` | `human`
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub label: Option<String>,
    /// Canvas position (designer layout; ignored by the runner).
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,

    // ── agent ──
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Prompt sent to the agent. `{{key}}` placeholders are filled from the
    /// blackboard (`{{goal}}` is the initial task).
    #[serde(default)]
    pub prompt_template: Option<String>,
    /// Blackboard key the agent's output is written to (defaults to node id).
    #[serde(default)]
    pub output_key: Option<String>,
    /// Retry budget if the agent turn fails (default 0 — no retry).
    #[serde(default)]
    pub max_retries: u32,
    /// What to do once retries are exhausted: `fail` (default, abort the run) or
    /// `skip` (record the error, write an empty output, advance to the next node).
    #[serde(default)]
    pub on_error: Option<String>,

    // ── branch ──
    #[serde(default)]
    pub evaluator: Option<BranchEvaluator>,
    #[serde(default)]
    pub cases: Vec<BranchCase>,
    #[serde(default)]
    pub default_to: Option<String>,

    // ── loop ──
    /// Entry node of the loop body. The body's terminal edge should point back
    /// to this loop node so the guard re-evaluates each iteration.
    #[serde(default)]
    pub body_to: Option<String>,
    #[serde(default)]
    pub guard: Option<LoopGuard>,

    // ── human ──
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub label: Option<String>,
    /// React Flow source handle id (editor layout only).
    #[serde(default)]
    pub source_handle: Option<String>,
    /// React Flow target handle id (editor layout only).
    #[serde(default)]
    pub target_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchCase {
    /// Label produced by the evaluator that selects this edge.
    pub label: String,
    pub to: String,
}

/// How a branch node decides which case to take.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BranchEvaluator {
    /// Run a judge agent turn; the returned text is matched against `labels`.
    Llm {
        classifier_prompt: String,
        #[serde(default)]
        labels: Vec<String>,
        /// Optional agent slug to act as judge; defaults to the first member.
        #[serde(default)]
        agent_id: Option<String>,
    },
    /// Evaluate a simple expression over the blackboard. Produces `true`/`false`.
    Expr { expr: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopGuard {
    #[serde(default = "default_loop_max")]
    pub max_iterations: u32,
    /// Optional expression; when it evaluates true the loop exits early.
    #[serde(default)]
    pub exit_when: Option<String>,
}

fn default_loop_max() -> u32 {
    5
}

// ─── Run state (persisted) ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRecord {
    pub node_id: String,
    pub kind: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub output_key: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub run_id: String,
    pub team_id: String,
    pub team_name: String,
    pub pool_id: String,
    pub project_dir: String,
    /// `running` | `waiting_human` | `completed` | `failed` | `cancelled`
    pub status: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub blackboard: Map<String, Value>,
    #[serde(default)]
    pub iter_counts: Map<String, Value>,
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub history: Vec<StepRecord>,
    #[serde(default)]
    pub error: Option<String>,
    /// The frozen graph this run executes (so edits to the team don't mutate
    /// an in-flight run).
    pub graph: WorkflowGraph,
    pub created_at: String,
    pub updated_at: String,
}

// ─── Persistence ──────────────────────────────────────────────────────────────

fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_global_config_dir(app)?.join("workflow-runs"))
}

// ── `&Path` cores (pure file ops; unit-testable with a tempdir) ──

fn save_run_to(dir: &Path, run: &WorkflowRun) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(run).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join(format!("{}.json", safe_run_id(&run.run_id))),
        pretty,
    )
    .map_err(|e| e.to_string())
}

fn load_run_from(dir: &Path, run_id: &str) -> Result<WorkflowRun, String> {
    let path = dir.join(format!("{}.json", safe_run_id(run_id)));
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("invalid workflow run: {e}"))
}

fn load_all_runs(dir: &Path) -> Vec<WorkflowRun> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    if let Ok(run) = serde_json::from_str::<WorkflowRun>(&text) {
                        out.push(run);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// True when a run is still advancing and so must not be deleted out from under
/// the driver.
fn is_active_status(status: &str) -> bool {
    status == "running" || status == "waiting_human"
}

/// Delete one run file. Refuses to delete an active run. Returns `Ok(false)`
/// when the file did not exist.
fn delete_run_in(dir: &Path, run_id: &str) -> Result<bool, String> {
    if let Ok(run) = load_run_from(dir, run_id) {
        if is_active_status(&run.status) {
            return Err("cannot delete an active run; cancel it first".to_string());
        }
    }
    let path = dir.join(format!("{}.json", safe_run_id(run_id)));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// Delete every finished run (completed / failed / cancelled). Returns the count
/// removed; active runs are left untouched.
fn clear_finished_in(dir: &Path) -> Result<u32, String> {
    let mut removed = 0u32;
    for run in load_all_runs(dir) {
        if matches!(run.status.as_str(), "completed" | "failed" | "cancelled") {
            let path = dir.join(format!("{}.json", safe_run_id(&run.run_id)));
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

// ── AppHandle wrappers ──

pub fn save_run(app: &AppHandle, run: &WorkflowRun) -> Result<(), String> {
    save_run_to(&runs_dir(app)?, run)
}

pub fn load_run(app: &AppHandle, run_id: &str) -> Result<WorkflowRun, String> {
    load_run_from(&runs_dir(app)?, run_id)
}

fn safe_run_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowStarted {
    pub run_id: String,
    pub pool_id: String,
}

/// Kick off a workflow run for a `mode: workflow` team. Syncs member agents to
/// kois, reuses/creates a pool_session for visualisation, freezes the team's
/// graph into the run, then spawns the background driver.
#[tauri::command]
pub async fn workflow_start(
    app: AppHandle,
    project_dir: String,
    team_id: String,
    goal: String,
) -> Result<WorkflowStarted, String> {
    let config_dir = resolve_global_config_dir(&app)?;
    let team = TeamManifest::load_by_id(&app, &team_id)?;
    if team.mode != "workflow" {
        return Err(format!("team '{}' is not a workflow team", team.id));
    }
    let mut graph = team
        .workflow
        .clone()
        .ok_or_else(|| "workflow team has no graph".to_string())?;
    graph.normalize_loop_nodes();
    graph.validate()?;

    let run_id = format!("wf-{}", uuid::Uuid::new_v4());
    let pool_name = format!(
        "{} · {}",
        team.name,
        &run_id[..8.min(run_id.len())]
    );

    let (db, _settings) = open_project_kernel_state(&app, &project_dir)?;
    let pool_id = {
        let db = db.lock().await;
        let synced = sync_agents_to_kois(&db, &config_dir);
        // Resolve member koi ids (members listed on the team).
        let mut member_koi_ids: Vec<String> = Vec::new();
        for member in &team.members {
            let slug = safe_id(member);
            let koi_id = synced
                .iter()
                .find(|a| safe_id(&a.id) == slug)
                .and_then(|a| a.koi_id.clone())
                .or_else(|| db.find_koi_by_name(&slug).ok().flatten().map(|k| k.id));
            if let Some(id) = koi_id {
                member_koi_ids.push(id);
            }
        }
        let pool = db
            .create_pool_session_with_meta(
                &pool_name,
                Some(&project_dir),
                team.task_timeout_secs,
                Some(&team.id),
                Some(&run_id),
            )
            .map_err(|e| e.to_string())?;
        let _ = db.update_pool_session_dir(&pool.id, &project_dir);
        for koi_id in &member_koi_ids {
            if !db.is_pool_member(&pool.id, koi_id).unwrap_or(false) {
                let _ = db.add_pool_member(&pool.id, koi_id);
            }
        }
        pool.id
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut blackboard = Map::new();
    blackboard.insert("goal".to_string(), Value::String(goal));
    let run = WorkflowRun {
        run_id: run_id.clone(),
        team_id: team.id.clone(),
        team_name: team.name.clone(),
        pool_id: pool_id.clone(),
        project_dir: project_dir.clone(),
        status: "running".to_string(),
        cursor: Some(graph.entry.clone()),
        blackboard,
        iter_counts: Map::new(),
        steps: 0,
        history: Vec::new(),
        error: None,
        graph,
        created_at: now.clone(),
        updated_at: now,
    };
    save_run(&app, &run)?;

    crate::runtime::workflow::spawn_driver(app.clone(), run_id.clone());

    Ok(WorkflowStarted { run_id, pool_id })
}

#[tauri::command]
pub async fn workflow_get_run(app: AppHandle, run_id: String) -> Result<WorkflowRun, String> {
    load_run(&app, &run_id)
}

#[tauri::command]
pub async fn workflow_list_runs(app: AppHandle) -> Result<Vec<WorkflowRun>, String> {
    Ok(load_all_runs(&runs_dir(&app)?))
}

#[tauri::command]
pub async fn workflow_cancel(app: AppHandle, run_id: String) -> Result<(), String> {
    crate::runtime::workflow::request_cancel(&run_id);
    crate::runtime::workflow::cancel_active_turn(&run_id).await;
    if let Ok(mut run) = load_run(&app, &run_id) {
        if run.status == "running" || run.status == "waiting_human" {
            run.status = "cancelled".to_string();
            run.updated_at = chrono::Utc::now().to_rfc3339();
            let _ = save_run(&app, &run);
        }
    }
    Ok(())
}

/// Delete a single persisted run. Refuses to delete a run that is still
/// `running` or `waiting_human` (cancel it first), so the driver never races a
/// file delete out from under itself.
#[tauri::command]
pub async fn workflow_delete_run(app: AppHandle, run_id: String) -> Result<(), String> {
    delete_run_in(&runs_dir(&app)?, &run_id).map(|_| ())
}

/// Delete every finished run (completed / failed / cancelled), leaving active
/// runs untouched. Returns how many were removed.
#[tauri::command]
pub async fn workflow_clear_finished(app: AppHandle) -> Result<u32, String> {
    clear_finished_in(&runs_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_graph() -> WorkflowGraph {
        serde_json::from_value(serde_json::json!({
            "entry": "start",
            "max_total_steps": 50,
            "nodes": [
                { "id": "start", "type": "start" },
                { "id": "a", "type": "agent", "agent_id": "coder", "max_retries": 2, "on_error": "skip" },
                { "id": "end", "type": "end" }
            ],
            "edges": [
                { "from": "start", "to": "a" },
                { "from": "a", "to": "end" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn valid_graph_passes() {
        assert!(agent_graph().validate().is_ok());
    }

    #[test]
    fn agent_fault_fields_round_trip() {
        let g = agent_graph();
        let a = g.node("a").unwrap();
        assert_eq!(a.max_retries, 2);
        assert_eq!(a.on_error.as_deref(), Some("skip"));
    }

    #[test]
    fn agent_fault_fields_default_when_absent() {
        let g: WorkflowGraph = serde_json::from_value(serde_json::json!({
            "entry": "start",
            "nodes": [
                { "id": "start", "type": "start" },
                { "id": "a", "type": "agent", "agent_id": "coder" }
            ],
            "edges": [{ "from": "start", "to": "a" }]
        }))
        .unwrap();
        let a = g.node("a").unwrap();
        assert_eq!(a.max_retries, 0);
        assert_eq!(a.on_error, None);
        // max_total_steps falls back to the default circuit breaker.
        assert_eq!(g.max_total_steps, default_max_steps());
    }

    #[test]
    fn missing_entry_is_rejected() {
        let g: WorkflowGraph = serde_json::from_value(serde_json::json!({
            "entry": "ghost",
            "nodes": [{ "id": "start", "type": "start" }],
            "edges": []
        }))
        .unwrap();
        assert!(g.validate().is_err());
    }

    #[test]
    fn agent_without_id_is_rejected() {
        let g: WorkflowGraph = serde_json::from_value(serde_json::json!({
            "entry": "start",
            "nodes": [
                { "id": "start", "type": "start" },
                { "id": "a", "type": "agent" }
            ],
            "edges": [{ "from": "start", "to": "a" }]
        }))
        .unwrap();
        assert!(g.validate().is_err());
    }

    #[test]
    fn next_of_follows_first_edge() {
        let g = agent_graph();
        assert_eq!(g.next_of("start").as_deref(), Some("a"));
        assert_eq!(g.next_of("a").as_deref(), Some("end"));
        assert_eq!(g.next_of("end"), None);
    }

    // ── Persistence (&Path cores) ──

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("agentz-wf-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_fixture(run_id: &str, status: &str) -> WorkflowRun {
        let now = "2026-01-01T00:00:00Z".to_string();
        WorkflowRun {
            run_id: run_id.into(),
            team_id: "team".into(),
            team_name: "Team".into(),
            pool_id: "pool".into(),
            project_dir: "/tmp/proj".into(),
            status: status.into(),
            cursor: None,
            blackboard: Map::new(),
            iter_counts: Map::new(),
            steps: 0,
            history: Vec::new(),
            error: None,
            graph: agent_graph(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn save_load_round_trip() {
        let dir = temp_dir();
        let run = run_fixture("wf-1", "completed");
        save_run_to(&dir, &run).unwrap();
        let loaded = load_run_from(&dir, "wf-1").unwrap();
        assert_eq!(loaded.run_id, "wf-1");
        assert_eq!(loaded.status, "completed");
        assert_eq!(loaded.graph.entry, run.graph.entry);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_refuses_active_run() {
        let dir = temp_dir();
        save_run_to(&dir, &run_fixture("wf-run", "running")).unwrap();
        save_run_to(&dir, &run_fixture("wf-wait", "waiting_human")).unwrap();
        save_run_to(&dir, &run_fixture("wf-done", "completed")).unwrap();

        assert!(delete_run_in(&dir, "wf-run").is_err());
        assert!(delete_run_in(&dir, "wf-wait").is_err());
        assert_eq!(delete_run_in(&dir, "wf-done"), Ok(true));
        // Deleting a missing run is a no-op success.
        assert_eq!(delete_run_in(&dir, "wf-missing"), Ok(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_finished_only_removes_terminal_runs() {
        let dir = temp_dir();
        save_run_to(&dir, &run_fixture("a", "completed")).unwrap();
        save_run_to(&dir, &run_fixture("b", "failed")).unwrap();
        save_run_to(&dir, &run_fixture("c", "cancelled")).unwrap();
        save_run_to(&dir, &run_fixture("d", "running")).unwrap();
        save_run_to(&dir, &run_fixture("e", "waiting_human")).unwrap();

        assert_eq!(clear_finished_in(&dir).unwrap(), 3);
        // The two active runs survive.
        let remaining = load_all_runs(&dir);
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().all(|r| is_active_status(&r.status)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_loop_nodes_derives_body_to_from_edges() {
        let mut g: WorkflowGraph = serde_json::from_value(serde_json::json!({
            "entry": "start",
            "nodes": [
                { "id": "start", "type": "start" },
                { "id": "loop", "type": "loop" },
                { "id": "body", "type": "agent", "agent_id": "coder" },
                { "id": "end", "type": "end" }
            ],
            "edges": [
                { "from": "start", "to": "loop" },
                { "from": "loop", "to": "body", "label": "body" },
                { "from": "loop", "to": "end" }
            ]
        }))
        .unwrap();
        g.normalize_loop_nodes();
        assert_eq!(g.node("loop").unwrap().body_to.as_deref(), Some("body"));
    }
}

/// Provide a value for a `human` node and resume the run from that node's
/// successor.
#[tauri::command]
pub async fn workflow_resume_human(
    app: AppHandle,
    run_id: String,
    output_key: String,
    value: String,
) -> Result<(), String> {
    let mut run = load_run(&app, &run_id)?;
    if run.status != "waiting_human" {
        return Err(format!("run '{}' is not waiting for input", run_id));
    }
    if !output_key.trim().is_empty() {
        run.blackboard.insert(output_key, Value::String(value));
    }
    // Advance past the human node.
    if let Some(cursor) = run.cursor.clone() {
        run.cursor = run.graph.next_of(&cursor);
    }
    run.status = "running".to_string();
    run.updated_at = chrono::Utc::now().to_rfc3339();
    save_run(&app, &run)?;
    crate::runtime::workflow::spawn_driver(app.clone(), run_id);
    Ok(())
}
