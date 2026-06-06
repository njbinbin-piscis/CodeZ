import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  Background,
  ConnectionLineType,
  MarkerType,
  addEdge,
  reconnectEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
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
import WfNode, { type WfNodeData } from "./WfNode";
import WfControls from "./WfControls";
import WfConnectionLine from "./WfConnectionLine";
import "./WorkflowDesigner.css";

const nodeTypes = { wf: WfNode };

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

function edgeColor(label: string | null | undefined): string {
  const l = (label ?? "").trim().toLowerCase();
  if (!l || l === "default") return "#6b6b80";
  if (l === "body") return "#4e9bf7";
  return "#f7b84e";
}

/** Top-to-bottom layers; siblings left-to-right within each layer. */
function autoLayout(graph: WorkflowGraph): WorkflowNode[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [graph.entry];
  depth.set(graph.entry, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const nxt of adj.get(cur) ?? []) {
      if (!depth.has(nxt)) {
        depth.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
  }
  let trailing = 0;
  const maxDepth = Math.max(0, ...Array.from(depth.values()));
  const rowCursor = new Map<number, number>();
  return graph.nodes.map((n) => {
    let d = depth.get(n.id);
    if (d === undefined) {
      d = maxDepth + 1 + trailing;
      trailing += 1;
    }
    const row = rowCursor.get(d) ?? 0;
    rowCursor.set(d, row + 1);
    return { ...n, x: 80 + row * 220, y: 60 + d * 140 };
  });
}

function defaultPosition(i: number): { x: number; y: number } {
  const cols = 3;
  return { x: 80 + (i % cols) * 220, y: 60 + Math.floor(i / cols) * 140 };
}

function pickEdgeHandles(
  fromId: string,
  toId: string,
  positions: Map<string, { x: number; y: number }>,
): { sourceHandle: string; targetHandle: string } {
  const from = positions.get(fromId);
  const to = positions.get(toId);
  if (!from || !to) return { sourceHandle: "bottom", targetHandle: "top" };

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? { sourceHandle: "bottom", targetHandle: "top" }
      : { sourceHandle: "top-out", targetHandle: "bottom-in" };
  }
  return dx >= 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left-out", targetHandle: "right-in" };
}

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

function graphToRfNodes(graph: WorkflowGraph, selectedNode: string | null): Node<WfNodeData>[] {
  return graph.nodes.map((n, i) => {
    const meta = KIND_META[n.type];
    const fallback = defaultPosition(i);
    return {
      id: n.id,
      type: "wf",
      position: { x: n.x ?? fallback.x, y: n.y ?? fallback.y },
      data: {
        glyph: meta.glyph,
        color: meta.color,
        title: n.label || n.id,
        sub: n.type === "agent" && n.agent_id ? `@${n.agent_id}` : undefined,
        kind: n.type,
      },
      selected: selectedNode === n.id,
      draggable: true,
      connectable: true,
    };
  });
}

function edgeHandles(
  e: WorkflowGraph["edges"][number],
  positions: Map<string, { x: number; y: number }>,
): { sourceHandle: string; targetHandle: string } {
  if (e.source_handle && e.target_handle) {
    return { sourceHandle: e.source_handle, targetHandle: e.target_handle };
  }
  return pickEdgeHandles(e.from, e.to, positions);
}

function graphToRfEdges(
  graph: WorkflowGraph,
  selectedEdge: string | null,
  positions: Map<string, { x: number; y: number }>,
): Edge[] {
  return graph.edges.map((e, i) => {
    const key = `${e.from}->${e.to}`;
    const selected = selectedEdge === key;
    const color = selected ? "#7c6af7" : edgeColor(e.label);
    const handles = edgeHandles(e, positions);
    return {
      id: `e-${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      type: "smoothstep",
      label: e.label || undefined,
      animated: true,
      reconnectable: true,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "var(--bg-elev, #14141c)", fillOpacity: 0.95 },
      labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
      style: { stroke: color, strokeWidth: selected ? 2.5 : 1.5 },
    };
  });
}

function withAutoHandles(
  edges: WorkflowGraph["edges"],
  positions: Map<string, { x: number; y: number }>,
): WorkflowGraph["edges"] {
  return edges.map((e) => {
    const h = pickEdgeHandles(e.from, e.to, positions);
    return { ...e, source_handle: h.sourceHandle, target_handle: h.targetHandle };
  });
}

function positionsFromGraph(graph: WorkflowGraph): Map<string, { x: number; y: number }> {
  return new Map(
    graph.nodes.map((n, i) => {
      const fallback = defaultPosition(i);
      return [n.id, { x: n.x ?? fallback.x, y: n.y ?? fallback.y }];
    }),
  );
}

function positionsFromNodes(nodes: Node[]): Map<string, { x: number; y: number }> {
  return new Map(nodes.map((n) => [n.id, n.position]));
}

function WorkflowDesignerInner({ graph, agents, onChange }: Props) {
  const { t } = useTranslation();
  const { fitView } = useReactFlow();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const graphRevRef = useRef(0);

  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node<WfNodeData>[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Re-sync canvas from graph when the graph changes externally (toolbar, inspector,
  // auto-layout) — but NOT while the user is dragging a node (that caused disappear).
  useEffect(() => {
    if (draggingRef.current) return;
    const pos = positionsFromGraph(graph);
    setNodes(graphToRfNodes(graph, selectedNode));
    setEdges(graphToRfEdges(graph, selectedEdge, pos));
    graphRevRef.current += 1;
  }, [graph, selectedNode, selectedEdge, setNodes, setEdges]);

  const commit = useCallback(
    (nodesIn: WorkflowNode[], edgesIn: WorkflowGraph["edges"]) => {
      onChange({ ...graph, nodes: deriveRouting(nodesIn, edgesIn), edges: edgesIn });
    },
    [graph, onChange],
  );

  const commitPositions = useCallback(
    (rfNodes: Node[]) => {
      const pos = positionsFromNodes(rfNodes);
      const nodesIn = graph.nodes.map((n) => {
        const p = pos.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : n;
      });
      commit(nodesIn, graph.edges);
    },
    [graph.nodes, graph.edges, commit],
  );

  const onNodesChangeWrapped = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const removes = changes
        .filter((c) => c.type === "remove")
        .map((c) => (c as { id: string }).id)
        .filter((id) => id !== graph.entry);
      if (removes.length > 0) {
        const keptNodes = graph.nodes.filter((n) => !removes.includes(n.id));
        const keptEdges = graph.edges.filter(
          (e) => !removes.includes(e.from) && !removes.includes(e.to),
        );
        commit(keptNodes, keptEdges);
        setSelectedNode(null);
      }
    },
    [graph.entry, graph.nodes, graph.edges, commit, onNodesChange],
  );

  const onEdgesChangeWrapped = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
    },
    [onEdgesChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const pos = positionsFromGraph(graph);
      const handles = pickEdgeHandles(conn.source, conn.target, pos);
      const edgeConn: Connection = {
        ...conn,
        sourceHandle: conn.sourceHandle ?? handles.sourceHandle,
        targetHandle: conn.targetHandle ?? handles.targetHandle,
      };
      setEdges((eds) =>
        addEdge(
          {
            ...edgeConn,
            type: "smoothstep",
            animated: true,
            reconnectable: true,
          },
          eds,
        ),
      );
      const exists = graph.edges.some((e) => e.from === conn.source && e.to === conn.target);
      if (exists) return;
      const edgesIn = [
        ...graph.edges,
        {
          from: conn.source,
          to: conn.target,
          label: null,
          source_handle: edgeConn.sourceHandle ?? null,
          target_handle: edgeConn.targetHandle ?? null,
        },
      ];
      commit(graph.nodes, edgesIn);
    },
    [graph, commit, setEdges],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (!newConnection.source || !newConnection.target) return;
      const nextHandles = {
        source_handle: newConnection.sourceHandle ?? oldEdge.sourceHandle ?? null,
        target_handle: newConnection.targetHandle ?? oldEdge.targetHandle ?? null,
      };
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
      const edgesIn = graph.edges.map((e) =>
        e.from === oldEdge.source && e.to === oldEdge.target
          ? {
              ...e,
              from: newConnection.source!,
              to: newConnection.target!,
              ...nextHandles,
            }
          : e,
      );
      commit(graph.nodes, edgesIn);
      setSelectedEdge(`${newConnection.source}->${newConnection.target}`);
    },
    [graph.nodes, graph.edges, commit, setEdges],
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

  const runAutoLayout = useCallback(() => {
    const laid = autoLayout(graph);
    const pos = new Map(
      laid.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]),
    );
    onChange({
      ...graph,
      nodes: laid,
      edges: withAutoHandles(graph.edges, pos),
    });
    requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 250 });
    });
  }, [graph, onChange, fitView]);

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
        <button type="button" className="wf-toolbar-layout" onClick={runAutoLayout}>
          ⊞ {t("workflow.autoLayout")}
        </button>
      </div>

      <div className="wf-canvas-wrap">
        <div className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChangeWrapped}
            onEdgesChange={onEdgesChangeWrapped}
            onConnect={onConnect}
            onReconnect={onReconnect}
            edgesUpdatable
            connectionRadius={32}
            reconnectRadius={24}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineComponent={WfConnectionLine}
            onNodeClick={(_, n) => {
              setSelectedNode(n.id);
              setSelectedEdge(null);
            }}
            onEdgeClick={(_, e) => {
              setSelectedEdge(`${e.source}->${e.target}`);
              setSelectedNode(null);
            }}
            onNodeDragStart={() => {
              draggingRef.current = true;
            }}
            onNodeDragStop={() => {
              draggingRef.current = false;
              commitPositions(nodesRef.current);
            }}
            onPaneClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.15}
            maxZoom={2}
            panOnDrag={[1, 2]}
            panOnScroll
            selectionOnDrag
            selectionKeyCode={null}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            elevateNodesOnSelect
            elevateEdgesOnSelect
            defaultEdgeOptions={{ interactionWidth: 20 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} />
            <WfControls />
          </ReactFlow>
        </div>

        <div className="wf-inspector">
          {!active && !selectedEdge && (
            <p className="agentz-settings-hint">{t("workflow.inspectorHint")}</p>
          )}

          {selectedEdge && (
            <div className="wf-inspector-body agentz-settings-field">
              <h4>{t("workflow.edge")}</h4>
              <p className="agentz-settings-hint">{t("workflow.edgeReconnectHint")}</p>
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

              <div className="agentz-settings-field">
                <label>{t("workflow.nodeLabel")}</label>
                <input
                  value={active.label ?? ""}
                  onChange={(e) => updateNode(active.id, { label: e.target.value })}
                />
              </div>

              {active.type === "agent" && (
                <>
                  <div className="agentz-settings-field">
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
                  </div>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.promptTemplate")}</label>
                    <textarea
                      rows={5}
                      value={active.prompt_template ?? ""}
                      placeholder="{{goal}}"
                      onChange={(e) => updateNode(active.id, { prompt_template: e.target.value })}
                    />
                  </div>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.outputKey")}</label>
                    <input
                      value={active.output_key ?? ""}
                      onChange={(e) => updateNode(active.id, { output_key: e.target.value })}
                    />
                  </div>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.maxRetries")}</label>
                    <input
                      type="number"
                      min={0}
                      value={active.max_retries ?? 0}
                      onChange={(e) =>
                        updateNode(active.id, { max_retries: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </div>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.onError")}</label>
                    <select
                      value={active.on_error ?? "fail"}
                      onChange={(e) => updateNode(active.id, { on_error: e.target.value })}
                    >
                      <option value="fail">{t("workflow.onErrorFail")}</option>
                      <option value="skip">{t("workflow.onErrorSkip")}</option>
                    </select>
                    <p className="agentz-settings-hint">{t("workflow.onErrorHint")}</p>
                  </div>
                </>
              )}

              {active.type === "branch" && (
                <>
                  <div className="agentz-settings-field">
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
                  </div>
                  {active.evaluator?.kind === "expr" && (
                    <div className="agentz-settings-field">
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
                    </div>
                  )}
                  {active.evaluator?.kind === "llm" && (
                    <>
                      <div className="agentz-settings-field">
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
                      </div>
                      <div className="agentz-settings-field">
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
                      </div>
                    </>
                  )}
                  <p className="agentz-settings-hint">{t("workflow.branchEdgeHint")}</p>
                </>
              )}

              {active.type === "loop" && (
                <>
                  <div className="agentz-settings-field">
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
                  </div>
                  <div className="agentz-settings-field">
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
                  </div>
                </>
              )}

              {active.type === "human" && (
                <>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.humanPrompt")}</label>
                    <textarea
                      rows={3}
                      value={active.prompt ?? ""}
                      onChange={(e) => updateNode(active.id, { prompt: e.target.value })}
                    />
                  </div>
                  <div className="agentz-settings-field">
                    <label>{t("workflow.outputKey")}</label>
                    <input
                      value={active.output_key ?? ""}
                      onChange={(e) => updateNode(active.id, { output_key: e.target.value })}
                    />
                  </div>
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

export default function WorkflowDesigner(props: Props) {
  return (
    <ReactFlowProvider>
      <WorkflowDesignerInner {...props} />
    </ReactFlowProvider>
  );
}
