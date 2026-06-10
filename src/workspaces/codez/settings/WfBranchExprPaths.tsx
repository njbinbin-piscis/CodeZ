import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import DropdownSelect from "../../../components/DropdownSelect";
import type { WorkflowGraph } from "../../../services/tauri/workflow";
import { exprBranchPaths, updateExprBranchPath } from "../../../services/tauri/workflowExpr";

interface WfBranchExprPathsProps {
  graph: WorkflowGraph;
  branchId: string;
  onChangeEdges: (edges: WorkflowGraph["edges"]) => void;
}

export default function WfBranchExprPaths({ graph, branchId, onChangeEdges }: WfBranchExprPathsProps) {
  const { t } = useTranslation();
  const { whenTrue, whenFalse } = useMemo(
    () => exprBranchPaths(graph, branchId),
    [graph, branchId],
  );

  const nodeLabel = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;

  const targetOptions = useMemo(() => {
    const opts = [{ id: "", label: t("workflow.branchPaths.unset") }];
    for (const n of graph.nodes) {
      if (n.id === branchId) continue;
      opts.push({ id: n.id, label: nodeLabel(n.id) });
    }
    return opts;
  }, [graph.nodes, branchId, t]);

  const setPath = (which: "true" | "false", targetId: string) => {
    onChangeEdges(updateExprBranchPath(graph.edges, branchId, which, targetId || null));
  };

  return (
    <div className="wf-branch-paths">
      <p className="agentz-settings-hint">{t("workflow.branchPaths.hint")}</p>
      <div className="wf-condition-row">
        <span className="wf-condition-label">{t("workflow.branchPaths.whenTrue")}</span>
        <DropdownSelect
          variant="field"
          value={whenTrue ?? ""}
          options={targetOptions}
          onChange={(v) => setPath("true", v)}
        />
      </div>
      <div className="wf-condition-row">
        <span className="wf-condition-label">{t("workflow.branchPaths.whenFalse")}</span>
        <DropdownSelect
          variant="field"
          value={whenFalse ?? ""}
          options={targetOptions}
          onChange={(v) => setPath("false", v)}
        />
      </div>
    </div>
  );
}
