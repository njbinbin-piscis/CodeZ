/**
 * Workflow teams (no-coordinator mode) IPC + graph schema.
 *
 * A workflow team runs a deterministic graph of agent steps with branching and
 * bounded loops — no Piscis coordinator. The backend driver walks the graph,
 * threads a shared blackboard, and runs each agent node through the same
 * in-process Koi runtime swarm teams use.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WorkflowNodeKind = "start" | "end" | "agent" | "branch" | "loop" | "human";

export interface BranchCase {
  label: string;
  to: string;
}

export type BranchEvaluator =
  | { kind: "llm"; classifier_prompt: string; labels: string[]; agent_id?: string | null }
  | { kind: "expr"; expr: string };

export interface LoopGuard {
  max_iterations: number;
  exit_when?: string | null;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeKind;
  label?: string | null;
  x?: number | null;
  y?: number | null;
  // agent
  agent_id?: string | null;
  prompt_template?: string | null;
  output_key?: string | null;
  /** Retry budget if the agent turn fails (default 0). */
  max_retries?: number;
  /** `fail` (default, abort run) or `skip` (record error, advance). */
  on_error?: string | null;
  // branch
  evaluator?: BranchEvaluator | null;
  cases?: BranchCase[];
  default_to?: string | null;
  // loop
  body_to?: string | null;
  guard?: LoopGuard | null;
  // human
  prompt?: string | null;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string | null;
}

export interface WorkflowGraph {
  entry: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  max_total_steps: number;
}

export interface StepRecord {
  node_id: string;
  kind: string;
  agent_id?: string | null;
  output_key?: string | null;
  label?: string | null;
  summary?: string | null;
  at: string;
}

export type WorkflowStatus =
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowRun {
  run_id: string;
  team_id: string;
  team_name: string;
  pool_id: string;
  project_dir: string;
  status: WorkflowStatus;
  cursor?: string | null;
  blackboard: Record<string, unknown>;
  iter_counts: Record<string, unknown>;
  steps: number;
  history: StepRecord[];
  error?: string | null;
  graph: WorkflowGraph;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStarted {
  run_id: string;
  pool_id: string;
}

export interface WorkflowEvent {
  runId: string;
  poolId: string;
  kind: string;
  nodeId?: string | null;
  status: WorkflowStatus;
  summary?: string | null;
  blackboard: Record<string, unknown>;
}

export function emptyGraph(): WorkflowGraph {
  return {
    entry: "start",
    nodes: [
      { id: "start", type: "start", label: "开始", x: 60, y: 180 },
      {
        id: "step-1",
        type: "agent",
        label: "步骤 1",
        prompt_template: "{{goal}}",
        output_key: "step-1",
        x: 320,
        y: 180,
      },
      { id: "end", type: "end", label: "结束", x: 620, y: 180 },
    ],
    edges: [
      { from: "start", to: "step-1", label: null },
      { from: "step-1", to: "end", label: null },
    ],
    max_total_steps: 100,
  };
}

/**
 * Validate a workflow graph for the issues the runner can hit. Returns
 * human-readable problem strings (empty = valid). Mirrors the backend
 * `WorkflowGraph::validate` plus reachability / routing checks.
 */
export function validateGraph(graph: WorkflowGraph): string[] {
  const issues: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;

  if (!graph.entry || !ids.has(graph.entry)) {
    issues.push("缺少入口节点（start）");
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push(`连线 ${e.from} → ${e.to} 指向不存在的节点`);
    }
  }
  for (const n of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === n.id);
    if (n.type === "agent") {
      if (!n.agent_id || !n.agent_id.trim()) issues.push(`「${label(n.id)}」未选择执行智能体`);
      if (out.length === 0) issues.push(`「${label(n.id)}」没有后继连线`);
    }
    if (n.type === "branch") {
      if (!n.evaluator) issues.push(`分支「${label(n.id)}」未配置判定方式`);
      if (out.length === 0) issues.push(`分支「${label(n.id)}」没有任何分支连线`);
    }
    if (n.type === "loop") {
      const hasBody = out.some((e) => (e.label ?? "").trim().toLowerCase() === "body");
      const hasExit = out.some((e) => (e.label ?? "").trim().toLowerCase() !== "body");
      if (!hasBody) issues.push(`循环「${label(n.id)}」缺少标记为 body 的循环体连线`);
      if (!hasExit) issues.push(`循环「${label(n.id)}」缺少退出连线`);
    }
    if ((n.type === "start" || n.type === "human") && out.length === 0) {
      issues.push(`「${label(n.id)}」没有后继连线`);
    }
  }
  return issues;
}

export function startWorkflow(
  projectDir: string,
  teamId: string,
  goal: string,
): Promise<WorkflowStarted> {
  return invoke<WorkflowStarted>("workflow_start", { projectDir, teamId, goal });
}

export function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  return invoke<WorkflowRun>("workflow_get_run", { runId });
}

export function listWorkflowRuns(): Promise<WorkflowRun[]> {
  return invoke<WorkflowRun[]>("workflow_list_runs");
}

export function cancelWorkflow(runId: string): Promise<void> {
  return invoke<void>("workflow_cancel", { runId });
}

export function deleteWorkflowRun(runId: string): Promise<void> {
  return invoke<void>("workflow_delete_run", { runId });
}

export function clearFinishedWorkflowRuns(): Promise<number> {
  return invoke<number>("workflow_clear_finished");
}

export function resumeWorkflowHuman(
  runId: string,
  outputKey: string,
  value: string,
): Promise<void> {
  return invoke<void>("workflow_resume_human", { runId, outputKey, value });
}

export function subscribeWorkflowEvents(
  handler: (event: WorkflowEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkflowEvent>("agentz:workflow-event", (e) => handler(e.payload));
}
