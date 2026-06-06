import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  addEdge,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import { useTranslation } from "react-i18next";
import type { AgentInfo } from "../../../services/tauri/agents";
import type {
  BranchEvaluator,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
} from "../../../services/tauri/workflow";
import "./WorkflowDesigner.css";

const KIND_META: Record<WorkflowNodeKind, { color: string; glyph: string }> = {
  start: { color: "#4ecdc4", glyph: "▶" },
  end: { color: "#fc5c65", glyph: "■" },
  agent: { color: "#7c6af7", glyph: "🤖" },
  branch: { color: "#f7b84e", glyph: "⑂" },
  loop: { color: "#4e9bf7", glyph: "↻" },
  human: { color: "#9a9ab0", glyph: "🧑" },
};

interface Props {
  graph: WorkflowGraph;
  agents: AgentInfo[];
  onChange: (graph: WorkflowGraph) => void;
}

let idCounter = 0;
function freshId(kind: string): string {
  idCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Recompute the runner's routing fields (branch cases/default_to, loop body_to)
 * from the canvas edges, so edges are the single source of truth for routing.
 */
function deriveRouting(nodes: WorkflowNode[], edges: WorkflowGraph["edges"]): WorkflowNode[] {
  return nodes.map((n) => {
    const out = edges.filter((e) => e.from === n.id);
    if (n.type === "branch") {
      const cases = out
        .filter((e) => (e.label ?? "").trim() && (e.label ?? "").trim().toLowerCase() !== "default")
        .map((e) => ({ label: (e.label ?? "").trim(), to: e.to }));
      const def = out.find(
        (e) => !(e.label ?? "").trim() || (e.label ?? "").trim().toLowerCase() === "default",
      );
      return { ...n, cases, default_to: def ? def.to : null };
    }
    if (n.type === "loop") {
      const body = out.find((e) => (e.label ?? "").trim().toLowerCase() === "body");
      return { ...n, body_to: body ? body.to : null };
    }
    return n;
  });
}

export default function WorkflowDesigner({ graph, agents, onChange }: Props) {
  const { t } = useTranslation();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const rfNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n, i) => {
        const meta = KIND_META[n.type];
        return {
          id: n.id,
          position: { x: n.x ?? 120 + (i % 4) * 180, y: n.y ?? 80 + Math.floor(i / 4) * 120 },
          data: {
            label: (
              <div className="wf-node-inner">
                <span className="wf-node-badge" style={{ background: meta.color }}>
                  {meta.glyph}
                </span>
                <span className="wf-node-title">{n.label || n.id}</span>
                {n.type === "agent" && n.agent_id && (
                  <span className="wf-node-sub">@{n.agent_id}</span>
                )}
              </div>
            ),
          },
          style: { borderColor: selectedNode === n.id ? meta.color : undefined },
          className: `wf-rf-node wf-kind-${n.type}`,
        } as Node;
      }),
    [graph.nodes, selectedNode],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e, i) => ({
        id: `e-${i}-${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        label: e.label || undefined,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: selectedEdge === `${e.from}->${e.to}` ? "#7c6af7" : "#555" },
      })),
    [graph.edges, selectedEdge],
  );

  const commit = useCallback(
    (nodes: WorkflowNode[], edges: WorkflowGraph["edges"]) => {
      onChange({ ...graph, nodes: deriveRouting(nodes, edges), edges });
    },
    [graph, onChange],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply position changes back into the graph.
      const positioned = applyNodeChanges(changes, rfNodes);
      const posMap = new Map(positioned.map((n) => [n.id, n.position]));
      const nodes = graph.nodes.map((n) => {
        const p = posMap.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : n;
      });
      // Honor node removals (but never the start node).
      const removed = changes
        .filter((c) => c.type === "remove")
        .map((c) => (c as { id: string }).id)
        .filter((id) => id !== graph.entry);
      const keptNodes = nodes.filter((n) => !removed.includes(n.id));
      const keptEdges = graph.edges.filter(
        (e) => !removed.includes(e.from) && !removed.includes(e.to),
      );
      commit(keptNodes, keptEdges);
    },
    [graph, rfNodes, commit],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const next = addEdge(conn, rfEdges);
      const edges = next.map((e) => ({
        from: e.source,
        to: e.target,
        label: typeof e.label === "string" ? e.label : null,
      }));
      commit(graph.nodes, edges);
    },
    [graph.nodes, rfEdges, commit],
  );

  const addNode = useCallback(
    (kind: WorkflowNodeKind) => {
      const id = freshId(kind);
      const node: WorkflowNode = {
        id,
        type: kind,
        label: t(`workflow.kind.${kind}`),
        x: 200 + Math.random() * 200,
        y: 120 + Math.random() * 160,
        ...(kind === "agent" ? { prompt_template: "{{goal}}", output_key: id } : {}),
        ...(kind === "branch"
          ? { evaluator: { kind: "expr", expr: "" } as BranchEvaluator, cases: [] }
          : {}),
        ...(kind === "loop" ? { guard: { max_iterations: 3, exit_when: null } } : {}),
        ...(kind === "human" ? { output_key: id } : {}),
      };
      setSelectedNode(id);
      commit([...graph.nodes, node], graph.edges);
    },
    [graph.nodes, graph.edges, commit, t],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<WorkflowNode>) => {
      commit(
        graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
        graph.edges,
      );
    },
    [graph.nodes, graph.edges, commit],
  );

  const updateEdgeLabel = useCallback(
    (key: string, label: string) => {
      const [from, to] = key.split("->");
      commit(
        graph.nodes,
        graph.edges.map((e) => (e.from === from && e.to === to ? { ...e, label } : e)),
      );
    },
    [graph.nodes, graph.edges, commit],
  );

  const removeEdge = useCallback(
    (key: string) => {
      const [from, to] = key.split("->");
      commit(
        graph.nodes,
        graph.edges.filter((e) => !(e.from === from && e.to === to)),
      );
      setSelectedEdge(null);
    },
    [graph.nodes, graph.edges, commit],
  );

  const removeNode = useCallback(
    (id: string) => {
      if (id === graph.entry) return;
      commit(
        graph.nodes.filter((n) => n.id !== id),
        graph.edges.filter((e) => e.from !== id && e.to !== id),
      );
      setSelectedNode(null);
    },
    [graph.entry, graph.nodes, graph.edges, commit],
  );

  const active = graph.nodes.find((n) => n.id === selectedNode) ?? null;

  return (
    <div className="wf-designer">
      <div className="wf-toolbar">
        <span className="wf-toolbar-label">{t("workflow.addNode")}:</span>
        {(["agent", "branch", "loop", "human", "end"] as WorkflowNodeKind[]).map((k) => (
          <button key={k} type="button" onClick={() => addNode(k)}>
            {KIND_META[k].glyph} {t(`workflow.kind.${k}`)}
          </button>
        ))}
      </div>

      <div className="wf-canvas-wrap">
        <div className="wf-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => {
              setSelectedNode(n.id);
              setSelectedEdge(null);
            }}
            onEdgeClick={(_, e) => {
              setSelectedEdge(`${e.source}->${e.target}`);
              setSelectedNode(null);
            }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        <div className="wf-inspector">
          {!active && !selectedEdge && (
            <p className="agentz-settings-hint">{t("workflow.inspectorHint")}</p>
          )}

          {selectedEdge && (
            <div className="wf-inspector-body">
              <h4>{t("workflow.edge")}</h4>
              <p className="agentz-settings-hint">{t("workflow.edgeLabelHint")}</p>
              <input
                value={graph.edges.find((e) => `${e.from}->${e.to}` === selectedEdge)?.label ?? ""}
                placeholder={t("workflow.edgeLabelPlaceholder")}
                onChange={(e) => updateEdgeLabel(selectedEdge, e.target.value)}
              />
              <button type="button" className="danger" onClick={() => removeEdge(selectedEdge)}>
                {t("workflow.removeEdge")}
              </button>
            </div>
          )}

          {active && (
            <div className="wf-inspector-body">
              <h4>
                {KIND_META[active.type].glyph} {t(`workflow.kind.${active.type}`)}
              </h4>
              <label>{t("workflow.nodeLabel")}</label>
              <input
                value={active.label ?? ""}
                onChange={(e) => updateNode(active.id, { label: e.target.value })}
              />

              {active.type === "agent" && (
                <>
                  <label>{t("workflow.agent")}</label>
                  <select
                    value={active.agent_id ?? ""}
                    onChange={(e) => updateNode(active.id, { agent_id: e.target.value })}
                  >
                    <option value="">—</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.name}
                      </option>
                    ))}
                  </select>
                  <label>{t("workflow.promptTemplate")}</label>
                  <textarea
                    rows={5}
                    value={active.prompt_template ?? ""}
                    placeholder="{{goal}}"
                    onChange={(e) => updateNode(active.id, { prompt_template: e.target.value })}
                  />
                  <label>{t("workflow.outputKey")}</label>
                  <input
                    value={active.output_key ?? ""}
                    onChange={(e) => updateNode(active.id, { output_key: e.target.value })}
                  />
                </>
              )}

              {active.type === "branch" && (
                <>
                  <label>{t("workflow.evaluator")}</label>
                  <select
                    value={active.evaluator?.kind ?? "expr"}
                    onChange={(e) =>
                      updateNode(active.id, {
                        evaluator:
                          e.target.value === "llm"
                            ? { kind: "llm", classifier_prompt: "", labels: [] }
                            : { kind: "expr", expr: "" },
                      })
                    }
                  >
                    <option value="expr">{t("workflow.evalExpr")}</option>
                    <option value="llm">{t("workflow.evalLlm")}</option>
                  </select>
                  {active.evaluator?.kind === "expr" && (
                    <>
                      <label>{t("workflow.expr")}</label>
                      <input
                        value={active.evaluator.expr}
                        placeholder="review contains approved"
                        onChange={(e) =>
                          updateNode(active.id, {
                            evaluator: { kind: "expr", expr: e.target.value },
                          })
                        }
                      />
                      <p className="agentz-settings-hint">{t("workflow.exprHint")}</p>
                    </>
                  )}
                  {active.evaluator?.kind === "llm" && (
                    <>
                      <label>{t("workflow.classifierPrompt")}</label>
                      <textarea
                        rows={3}
                        value={active.evaluator.classifier_prompt}
                        onChange={(e) =>
                          updateNode(active.id, {
                            evaluator: {
                              ...(active.evaluator as { kind: "llm"; labels: string[] }),
                              kind: "llm",
                              classifier_prompt: e.target.value,
                            },
                          })
                        }
                      />
                      <label>{t("workflow.labels")}</label>
                      <input
                        value={(active.evaluator.labels ?? []).join(", ")}
                        placeholder="approved, changes_requested"
                        onChange={(e) =>
                          updateNode(active.id, {
                            evaluator: {
                              kind: "llm",
                              classifier_prompt:
                                (active.evaluator as { classifier_prompt?: string })
                                  .classifier_prompt ?? "",
                              labels: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          })
                        }
                      />
                    </>
                  )}
                  <p className="agentz-settings-hint">{t("workflow.branchEdgeHint")}</p>
                </>
              )}

              {active.type === "loop" && (
                <>
                  <label>{t("workflow.maxIterations")}</label>
                  <input
                    type="number"
                    min={1}
                    value={active.guard?.max_iterations ?? 3}
                    onChange={(e) =>
                      updateNode(active.id, {
                        guard: {
                          max_iterations: Number(e.target.value) || 1,
                          exit_when: active.guard?.exit_when ?? null,
                        },
                      })
                    }
                  />
                  <label>{t("workflow.exitWhen")}</label>
                  <input
                    value={active.guard?.exit_when ?? ""}
                    placeholder="review contains approved"
                    onChange={(e) =>
                      updateNode(active.id, {
                        guard: {
                          max_iterations: active.guard?.max_iterations ?? 3,
                          exit_when: e.target.value || null,
                        },
                      })
                    }
                  />
                  <p className="agentz-settings-hint">{t("workflow.loopEdgeHint")}</p>
                </>
              )}

              {active.type === "human" && (
                <>
                  <label>{t("workflow.humanPrompt")}</label>
                  <textarea
                    rows={3}
                    value={active.prompt ?? ""}
                    onChange={(e) => updateNode(active.id, { prompt: e.target.value })}
                  />
                  <label>{t("workflow.outputKey")}</label>
                  <input
                    value={active.output_key ?? ""}
                    onChange={(e) => updateNode(active.id, { output_key: e.target.value })}
                  />
                </>
              )}

              {active.type !== "start" && (
                <button type="button" className="danger" onClick={() => removeNode(active.id)}>
                  {t("workflow.removeNode")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
