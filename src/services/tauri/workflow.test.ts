import { describe, expect, it } from "vitest";
import { emptyGraph, validateGraph, type WorkflowGraph } from "./workflow";

describe("validateGraph", () => {
  it("accepts the starter graph once its agent is chosen", () => {
    const g = emptyGraph();
    // The scaffold ships with an unset agent on purpose; choosing one yields a
    // fully valid graph (start -> agent -> end).
    g.nodes = g.nodes.map((n) => (n.type === "agent" ? { ...n, agent_id: "coder" } : n));
    expect(validateGraph(g)).toEqual([]);
  });

  it("flags the unset agent in the raw starter graph", () => {
    expect(validateGraph(emptyGraph()).some((i) => i.includes("智能体"))).toBe(true);
  });

  it("flags an agent node with no agent selected", () => {
    const g = emptyGraph();
    // step-1 is the agent node; clear its agent_id.
    g.nodes = g.nodes.map((n) => (n.type === "agent" ? { ...n, agent_id: "" } : n));
    const issues = validateGraph(g);
    expect(issues.some((i) => i.includes("智能体"))).toBe(true);
  });

  it("flags a missing / unknown entry node", () => {
    const g = emptyGraph();
    g.entry = "ghost";
    expect(validateGraph(g).some((i) => i.includes("入口"))).toBe(true);
  });

  it("flags an edge pointing at a non-existent node", () => {
    const g = emptyGraph();
    g.edges = [...g.edges, { from: "step-1", to: "nowhere", label: null }];
    expect(validateGraph(g).some((i) => i.includes("nowhere"))).toBe(true);
  });

  it("flags a loop missing its body or exit edge", () => {
    const g: WorkflowGraph = {
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "lp", type: "loop", guard: { max_iterations: 3, exit_when: null } },
        { id: "work", type: "agent", agent_id: "coder" },
        { id: "end", type: "end" },
      ],
      // Only a body edge, no exit edge from the loop.
      edges: [
        { from: "start", to: "lp", label: null },
        { from: "lp", to: "work", label: "body" },
        { from: "work", to: "lp", label: null },
      ],
      max_total_steps: 50,
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.includes("退出"))).toBe(true);
  });

  it("flags a node with no outgoing edge", () => {
    const g: WorkflowGraph = {
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agent_id: "coder" },
      ],
      edges: [{ from: "start", to: "a", label: null }],
      max_total_steps: 50,
    };
    expect(validateGraph(g).some((i) => i.includes("后继"))).toBe(true);
  });

  it("flags an expr branch missing true/false paths", () => {
    const g: WorkflowGraph = {
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "b",
          type: "branch",
          evaluator: { kind: "expr", expr: "review contains approved" },
        },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "start", to: "b", label: null }],
      max_total_steps: 50,
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.includes("true"))).toBe(true);
    expect(issues.some((i) => i.includes("false"))).toBe(true);
  });
});
