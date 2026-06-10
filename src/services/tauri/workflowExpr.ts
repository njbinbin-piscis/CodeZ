/**
 * Blackboard condition expressions — parse/format helpers aligned with
 * `eval_expr` in `src-tauri/src/runtime/workflow.rs`.
 */
import type { WorkflowGraph } from "./workflow";

export type ConditionOp = "contains" | "not_contains" | "eq" | "neq" | "truthy";

export interface ParsedCondition {
  key: string;
  op: ConditionOp;
  value: string;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function quoteIfNeeded(value: string): string {
  const v = value.trim();
  if (!v) return '""';
  if (/[\s"]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

/** Parse a blackboard expression into structured fields. */
export function parseCondition(expr: string): ParsedCondition {
  const raw = expr.trim();
  if (!raw) return { key: "", op: "contains", value: "" };

  const lower = raw.toLowerCase();
  for (const [token, op] of [
    ["!contains", "not_contains"],
    ["contains", "contains"],
  ] as const) {
    const idx = lower.indexOf(token);
    if (idx >= 0) {
      return {
        key: raw.slice(0, idx).trim(),
        op,
        value: stripQuotes(raw.slice(idx + token.length)),
      };
    }
  }
  const eqIdx = raw.indexOf("==");
  if (eqIdx >= 0) {
    return {
      key: raw.slice(0, eqIdx).trim(),
      op: "eq",
      value: stripQuotes(raw.slice(eqIdx + 2)),
    };
  }
  const neIdx = raw.indexOf("!=");
  if (neIdx >= 0) {
    return {
      key: raw.slice(0, neIdx).trim(),
      op: "neq",
      value: stripQuotes(raw.slice(neIdx + 2)),
    };
  }
  return { key: raw, op: "truthy", value: "" };
}

/** Serialize structured fields back to an expression string. */
export function formatCondition(c: ParsedCondition): string {
  const key = c.key.trim();
  if (!key) return "";
  switch (c.op) {
    case "contains":
      return `${key} contains ${quoteIfNeeded(c.value)}`.trim();
    case "not_contains":
      return `${key} !contains ${quoteIfNeeded(c.value)}`.trim();
    case "eq":
      return `${key} == ${quoteIfNeeded(c.value)}`;
    case "neq":
      return `${key} != ${quoteIfNeeded(c.value)}`;
    case "truthy":
      return key;
    default:
      return key;
  }
}

/** Keys available on the workflow blackboard for condition pickers. */
export function blackboardKeysFromGraph(graph: WorkflowGraph): string[] {
  const keys = new Set<string>(["goal"]);
  for (const n of graph.nodes) {
    if (n.type === "agent" || n.type === "human") {
      keys.add((n.output_key?.trim() || n.id).trim());
    }
  }
  return [...keys].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** Targets for expr-branch true / false outgoing edges. */
export function exprBranchPaths(
  graph: WorkflowGraph,
  branchId: string,
): { whenTrue: string | null; whenFalse: string | null } {
  const out = graph.edges.filter((e) => e.from === branchId);
  const trueEdge = out.find((e) => (e.label ?? "").trim().toLowerCase() === "true");
  const falseEdge = out.find((e) => {
    const l = (e.label ?? "").trim().toLowerCase();
    return l === "false" || l === "default" || l === "";
  });
  return { whenTrue: trueEdge?.to ?? null, whenFalse: falseEdge?.to ?? null };
}

function edgeMatchesExprPath(e: WorkflowGraph["edges"][number], which: "true" | "false"): boolean {
  const l = (e.label ?? "").trim().toLowerCase();
  if (which === "true") return l === "true";
  return l === "false" || l === "default" || l === "";
}

/** Set or clear the target node for an expr-branch true/false path. */
export function updateExprBranchPath(
  edges: WorkflowGraph["edges"],
  branchId: string,
  which: "true" | "false",
  targetId: string | null,
): WorkflowGraph["edges"] {
  const kept = edges.filter((e) => !(e.from === branchId && edgeMatchesExprPath(e, which)));
  if (!targetId) return kept;
  const label = which === "true" ? "true" : "false";
  return [...kept, { from: branchId, to: targetId, label }];
}
