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
      { id: "start", type: "start", label: "开始", x: 80, y: 200 },
      { id: "end", type: "end", label: "结束", x: 700, y: 200 },
    ],
    edges: [],
    max_total_steps: 100,
  };
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
