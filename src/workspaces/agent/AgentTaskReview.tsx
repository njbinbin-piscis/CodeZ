import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  agentTaskApi,
  type AgentTaskChange,
  type AgentTaskInfo,
} from "../../services/tauri/agentTask";
import { diffLines } from "../ide/lineDiff";
import "./AgentTaskReview.css";

interface AgentTaskReviewProps {
  projectDir: string;
  task: AgentTaskInfo;
  onClose: () => void;
  /** Called after a merge / discard so the parent can refresh its task list. */
  onResolved: () => void;
}

/**
 * Review the diff produced by an isolated Agent task (M4): list the files
 * changed on the task branch, show a per-file line diff, then merge the branch
 * back into base, open a PR, or discard the worktree + branch.
 */
export default function AgentTaskReview({
  projectDir,
  task,
  onClose,
  onResolved,
}: AgentTaskReviewProps) {
  const { t } = useTranslation();
  const [changes, setChanges] = useState<AgentTaskChange[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [modified, setModified] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = task.base || "HEAD";

  const loadChanges = useCallback(async () => {
    try {
      const list = await agentTaskApi.changedFiles(projectDir, task.branch, base);
      setChanges(list);
      if (list.length > 0 && !selected) setSelected(list[0].path);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, task.branch, base]);

  useEffect(() => {
    void loadChanges();
  }, [loadChanges]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await agentTaskApi.fileDiff(projectDir, task.branch, base, selected);
        if (cancelled) return;
        setOriginal(d.original);
        setModified(d.modified);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, projectDir, task.branch, base]);

  const merge = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await agentTaskApi.merge(projectDir, task.branch, base);
      setStatus(t("agent.mergeOk", { base }));
      onResolved();
    } catch (e) {
      setError(t("agent.mergeFail", { msg: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [projectDir, task.branch, base, t, onResolved]);

  const discard = useCallback(async () => {
    if (!window.confirm(t("agent.discardConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await agentTaskApi.discard(projectDir, task.worktree_path, task.branch);
      onResolved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, task, t, onResolved, onClose]);

  const openPr = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await agentTaskApi.openPr(
        projectDir,
        task.branch,
        base,
        `Agent task ${task.id}`,
        undefined,
      );
      if (res.ok && res.url) setStatus(t("agent.prOk", { url: res.url }));
      else setError(t("agent.prFail", { msg: res.message }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, task, base, t]);

  const ops = modified || original ? diffLines(original.split("\n"), modified.split("\n")) : [];

  return (
    <div className="codez-task-review-overlay" onClick={onClose}>
      <div className="codez-task-review" onClick={(e) => e.stopPropagation()}>
        <div className="codez-task-review-head">
          <div className="codez-task-review-titles">
            <span className="codez-task-review-title">{t("agent.reviewTitle")}</span>
            <span className="codez-task-review-meta">
              {t("agent.reviewBranch")}: <code>{task.branch}</code> · {t("agent.reviewBase")}:{" "}
              <code>{base}</code>
            </span>
          </div>
          <button type="button" className="codez-task-review-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="codez-task-review-body">
          <div className="codez-task-review-files">
            {changes.length === 0 ? (
              <div className="codez-task-review-empty">{t("agent.reviewEmpty")}</div>
            ) : (
              changes.map((c) => (
                <button
                  key={c.path}
                  type="button"
                  className={`codez-task-review-file ${c.path === selected ? "active" : ""}`}
                  onClick={() => setSelected(c.path)}
                >
                  <span className={`codez-task-review-badge ${c.status}`}>
                    {c.status.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="codez-task-review-path">{c.path}</span>
                </button>
              ))
            )}
          </div>
          <div className="codez-task-review-diff">
            {selected ? (
              <pre className="codez-task-review-diff-pre">
                {ops.map((op, i) => (
                  <div
                    key={i}
                    className={`codez-diff-line ${op.type}`}
                  >
                    <span className="codez-diff-sign">
                      {op.type === "add" ? "+" : op.type === "remove" ? "-" : " "}
                    </span>
                    {op.text}
                  </div>
                ))}
              </pre>
            ) : (
              <div className="codez-task-review-empty">{t("agent.reviewEmpty")}</div>
            )}
          </div>
        </div>

        {status && <div className="codez-task-review-status ok">{status}</div>}
        {error && <div className="codez-task-review-status err">{error}</div>}

        <div className="codez-task-review-actions">
          <button type="button" onClick={discard} disabled={busy} className="danger">
            {t("agent.discard")}
          </button>
          <div className="codez-task-review-actions-right">
            <button type="button" onClick={openPr} disabled={busy}>
              {t("agent.openPr")}
            </button>
            <button type="button" onClick={merge} disabled={busy} className="primary">
              {busy ? t("agent.merging") : t("agent.merge")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
