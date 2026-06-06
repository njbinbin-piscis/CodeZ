import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelWorkflow,
  getWorkflowRun,
  resumeWorkflowHuman,
  subscribeWorkflowEvents,
  type WorkflowRun,
} from "../../services/tauri/workflow";
import { onChatEvent, type AgentEvent, type ChatEventEnvelope } from "../../services/tauri/chat";
import "./WorkflowRunPanel.css";

interface Props {
  runId: string;
  onClose: () => void;
}

const KIND_GLYPH: Record<string, string> = {
  start: "▶",
  end: "■",
  agent: "🤖",
  branch: "⑂",
  loop: "↻",
  human: "🧑",
};

/**
 * Live view of a workflow run: the node list with the active node highlighted,
 * the shared blackboard, the step history, and a human-input prompt when the
 * run pauses on a `human` node. Refreshes on every `agentz:workflow-event`.
 */
export default function WorkflowRunPanel({ runId, onClose }: Props) {
  const { t } = useTranslation();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [humanValue, setHumanValue] = useState("");
  const [liveText, setLiveText] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setRun(await getWorkflowRun(runId));
    } catch {
      // best-effort; the next event refreshes
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeWorkflowEvents((e) => {
      if (e.runId === runId) void refresh();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [runId, refresh]);

  // Stream each agent node's tokens (Koi turns stream over the shared chat
  // channel keyed by `{run_id}::{node_id}`).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const prefix = `${runId}::`;
    onChatEvent((env: ChatEventEnvelope) => {
      if (!env.sessionId || !env.sessionId.startsWith(prefix)) return;
      if (env.channel !== "agent_event") return;
      const nodeId = env.sessionId.slice(prefix.length).replace(/::judge$/, "");
      const evt = env.payload as AgentEvent;
      if (evt.type === "text_delta") {
        setLiveText((prev) => ({ ...prev, [nodeId]: (prev[nodeId] ?? "") + evt.delta }));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [runId]);

  const submitHuman = useCallback(async () => {
    if (!run?.cursor) return;
    const node = run.graph.nodes.find((n) => n.id === run.cursor);
    const key = node?.output_key || run.cursor;
    try {
      await resumeWorkflowHuman(runId, key, humanValue);
      setHumanValue("");
      void refresh();
    } catch {
      // ignore; UI re-polls
    }
  }, [run, runId, humanValue, refresh]);

  const blackboard = run?.blackboard ?? {};
  const humanNode =
    run?.status === "waiting_human" && run.cursor
      ? run.graph.nodes.find((n) => n.id === run.cursor)
      : null;

  return (
    <div className="agentz-wfrun-overlay" onClick={onClose}>
      <div className="agentz-wfrun" onClick={(e) => e.stopPropagation()}>
        <div className="agentz-wfrun-head">
          <div>
            <strong>{run?.team_name ?? t("workflow.running")}</strong>
            {run && (
              <span className={`agentz-wfrun-status ${run.status}`}>
                {run.status === "running"
                  ? t("workflow.running")
                  : run.status === "waiting_human"
                    ? t("workflow.waitingHuman")
                    : run.status}
                {" · "}
                {t("workflow.steps")}: {run.steps}
              </span>
            )}
          </div>
          <div className="agentz-wfrun-head-actions">
            {run && (run.status === "running" || run.status === "waiting_human") && (
              <button type="button" onClick={() => void cancelWorkflow(runId)}>
                {t("workflow.cancel")}
              </button>
            )}
            <button type="button" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {run?.error && <div className="agentz-wfrun-error">{run.error}</div>}

        <div className="agentz-wfrun-body">
          <div className="agentz-wfrun-col">
            <h4>{t("workflow.designer")}</h4>
            <div className="agentz-wfrun-nodes">
              {run?.graph.nodes.map((n) => (
                <div
                  key={n.id}
                  className={`agentz-wfrun-node ${run.cursor === n.id ? "active" : ""} ${
                    run.history.some((h) => h.node_id === n.id) ? "visited" : ""
                  }`}
                >
                  <span className="agentz-wfrun-node-glyph">{KIND_GLYPH[n.type] ?? "•"}</span>
                  <span className="agentz-wfrun-node-label">{n.label || n.id}</span>
                  {n.agent_id && <span className="agentz-wfrun-node-agent">@{n.agent_id}</span>}
                </div>
              ))}
            </div>

            {run?.status === "running" && run.cursor && liveText[run.cursor] && (
              <>
                <h4>{t("workflow.liveOutput")}</h4>
                <div className="agentz-wfrun-live">{liveText[run.cursor]}</div>
              </>
            )}

            <h4>{t("workflow.steps")}</h4>
            <div className="agentz-wfrun-history">
              {(run?.history ?? []).map((h, i) => (
                <div key={i} className="agentz-wfrun-hrow">
                  <span className="agentz-wfrun-hglyph">{KIND_GLYPH[h.kind] ?? "•"}</span>
                  <span className="agentz-wfrun-hnode">{h.node_id}</span>
                  {h.label && <span className="agentz-wfrun-hlabel">{h.label}</span>}
                  {h.summary && <span className="agentz-wfrun-hsummary">{h.summary}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="agentz-wfrun-col">
            <h4>{t("workflow.blackboard")}</h4>
            <div className="agentz-wfrun-bb">
              {Object.entries(blackboard).map(([k, v]) => (
                <div key={k} className="agentz-wfrun-bb-item">
                  <div className="agentz-wfrun-bb-key">{k}</div>
                  <div className="agentz-wfrun-bb-val">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {humanNode && (
          <div className="agentz-wfrun-human">
            <div className="agentz-wfrun-human-prompt">
              🧑 {humanNode.prompt || humanNode.label || t("workflow.waitingHuman")}
            </div>
            <textarea
              rows={2}
              value={humanValue}
              onChange={(e) => setHumanValue(e.target.value)}
            />
            <button type="button" onClick={() => void submitHuman()}>
              {t("workflow.submitHuman")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
