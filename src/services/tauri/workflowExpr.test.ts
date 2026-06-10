import { describe, expect, it } from "vitest";
import {
  blackboardKeysFromGraph,
  exprBranchPaths,
  formatCondition,
  parseCondition,
  updateExprBranchPath,
} from "./workflowExpr";
import type { WorkflowGraph } from "./workflow";

describe("workflowExpr", () => {
  it("round-trips contains expressions", () => {
    const c = parseCondition("review contains approved");
    expect(c).toEqual({ key: "review", op: "contains", value: "approved" });
    expect(formatCondition(c)).toBe("review contains approved");
  });

  it("parses negated contains and equality", () => {
    expect(parseCondition("review !contains rejected")).toEqual({
      key: "review",
      op: "not_contains",
      value: "rejected",
    });
    expect(parseCondition('status == "done"')).toEqual({
      key: "status",
      op: "eq",
      value: "done",
    });
  });

  it("collects blackboard keys from agents and goal", () => {
    const g: WorkflowGraph = {
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agent_id: "x", output_key: "review" },
        { id: "h", type: "human", output_key: "answer" },
      ],
      edges: [],
      max_total_steps: 10,
    };
    expect(blackboardKeysFromGraph(g)).toEqual(["answer", "goal", "review"]);
  });

  it("updates expr branch true/false edges", () => {
    const edges = [{ from: "b", to: "yes", label: "true" }];
    const next = updateExprBranchPath(edges, "b", "false", "no");
    expect(next).toEqual([
      { from: "b", to: "yes", label: "true" },
      { from: "b", to: "no", label: "false" },
    ]);
    const paths = exprBranchPaths(
      {
        entry: "start",
        nodes: [],
        edges: next,
        max_total_steps: 10,
      },
      "b",
    );
    expect(paths).toEqual({ whenTrue: "yes", whenFalse: "no" });
  });
});
