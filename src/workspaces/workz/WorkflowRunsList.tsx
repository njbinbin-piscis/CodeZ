import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearFinishedWorkflowRuns,
  deleteWorkflowRun,
  listWorkflowRuns,
  subscribeWorkflowEvents,
  type WorkflowRun,
} from "../../services/tauri/workflow";
import "./WorkflowRunPanel.css";

interface Props {
  /** When set, only runs of this team id are shown. */
  teamId?: string | null;
  onSelect: (runId: string) => void;
  onClose: () => void;
}

/** Browser of past workflow runs (newest first), optionally scoped to a team. */
export default function WorkflowRunsList({ teamId, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [showAll, setShowAll] = useState(!teamId);

  const refresh = useCallback(async () => {
    try {
      setRuns(await listWorkflowRuns());
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the list live: a run finishing / advancing while the browser is open
  // should refresh its status without a manual reload.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeWorkflowEvents(() => void refresh()).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [refresh]);

  const removeRun = useCallback(
    async (runId: string) => {
      try {
        await deleteWorkflowRun(runId);
        setRuns((prev) => prev.filter((r) => r.run_id !== runId));
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  const clearFinished = useCallback(async () => {
    try {
      await clearFinishedWorkflowRuns();
    } finally {
      void refresh();
    }
  }, [refresh]);

  const visible = runs.filter((r) => showAll || !teamId || r.team_id === teamId);
  const hasFinished = visible.some((r) =>
    ["completed", "failed", "cancelled"].includes(r.status),
  );
  const isActive = (s: string) => s === "running" || s === "waiting_human";

  return (
    <div className="agentz-wfrun-overlay" onClick={onClose}>
      <div className="agentz-wfrun agentz-wfruns" onClick={(e) => e.stopPropagation()}>
        <div className="agentz-wfrun-head">
          <strong>{t("workflow.history")}</strong>
          <div className="agentz-wfrun-head-actions">
            {teamId && (
              <label className="agentz-wfruns-filter">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                {t("workflow.showAllTeams")}
              </label>
            )}
            {hasFinished && (
              <button type="button" onClick={() => void clearFinished()}>
                {t("workflow.clearFinished")}
              </button>
            )}
            <button type="button" onClick={() => void refresh()}>
              ⟳
            </button>
            <button type="button" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="agentz-wfruns-list">
          {visible.length === 0 && <p className="agentz-settings-hint">{t("workflow.noRuns")}</p>}
          {visible.map((r) => (
            <div key={r.run_id} className="agentz-wfruns-row">
              <button
                type="button"
                className="agentz-wfruns-open"
                onClick={() => onSelect(r.run_id)}
              >
                <span className={`agentz-wfruns-status ${r.status}`}>
                  {t(`workflow.status.${r.status}`)}
                </span>
                <span className="agentz-wfruns-name">{r.team_name}</span>
                <span className="agentz-wfruns-goal">
                  {typeof r.blackboard.goal === "string" ? r.blackboard.goal : ""}
                </span>
                <span className="agentz-wfruns-meta">
                  {t("workflow.steps")}: {r.steps} · {new Date(r.created_at).toLocaleString()}
                </span>
              </button>
              {!isActive(r.status) && (
                <button
                  type="button"
                  className="agentz-wfruns-del"
                  title={t("workflow.deleteRun")}
                  onClick={() => void removeRun(r.run_id)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
