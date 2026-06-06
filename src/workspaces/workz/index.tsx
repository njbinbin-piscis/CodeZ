import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  chatSend,
  chatCancel,
  onChatEvent,
  listSessions,
  getMessages,
  deleteSession,
  type AgentEvent,
  type ChatAttachment,
  type ChatEventEnvelope,
  type PlanTodoItem,
  type SessionMeta,
} from "../../services/tauri/chat";
import { getSettings, type LlmProviderConfig } from "../../services/tauri/settings";
import { ideApi } from "../../services/tauri/ide";
import { agentTaskApi, type AgentTaskInfo } from "../../services/tauri/agentTask";
import { generateRepoWiki } from "../../services/tauri/repoWiki";
import AgentTaskReview from "./AgentTaskReview";
import ChatComposer, { type ComposerMenuOption } from "../../components/ChatComposer";
import { modelLabel, pickChatAttachment } from "../../components/chatComposerUtils";
import TaskPanel, {
  mergePlanItems,
  parsePlanFromToolInput,
  type ToolStep,
} from "../../components/TaskPanel";
import type { GitFileStatus } from "../codez/types";
import Markdown from "../codez/Markdown";
import InteractiveCard from "../../components/chat/InteractiveCard";
import { useInteractiveCards } from "../../hooks/useInteractiveCards";
import ArtifactsDrawer from "./ArtifactsDrawer";
import AgentFilePreview from "./AgentFilePreview";
import CollabBoard from "./CollabBoard";
import WorkflowRunPanel from "./WorkflowRunPanel";
import WorkflowRunsList from "./WorkflowRunsList";
import { listTeams, createPoolFromTeam, type TeamInfo } from "../../services/tauri/teams";
import {
  startWorkflow,
  subscribeWorkflowEvents,
  type WorkflowStatus,
} from "../../services/tauri/workflow";
import {
  collectArtifacts,
  type AgentStep,
} from "./agentArtifacts";
import { applyToolEnd, applyToolStart, finalizeTools } from "./agentTools";
import "./Agent.css";

interface WorkZWorkspaceProps {
  projectDir: string | null;
  onOpenFolder: () => void;
  /** Increment from title bar to trigger repo wiki generation. */
  wikiBuildNonce?: number;
  onWikiBusyChange?: (busy: boolean) => void;
}

/**
 * Agent mode (≈ Codex) — task-centric autonomous coding.
 *
 * Each task is a kernel session: submit a goal, the agent plans → edits → runs
 * tools in the open project, streaming its steps. The task list shows past runs
 * and a Changes panel surfaces the resulting `git status` for review.
 */
export default function WorkZWorkspace({
  projectDir,
  onOpenFolder,
  wikiBuildNonce = 0,
  onWikiBusyChange,
}: WorkZWorkspaceProps) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<SessionMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [changes, setChanges] = useState<GitFileStatus[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [wikiBusy, setWikiBusy] = useState(false);
  const [modelId, setModelId] = useState(() => localStorage.getItem("agentz-model-id") ?? "");
  const [llmProviders, setLlmProviders] = useState<LlmProviderConfig[]>([]);
  const [defaultModelLabel, setDefaultModelLabel] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [planItems, setPlanItems] = useState<PlanTodoItem[]>([]);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [taskPanelTab, setTaskPanelTab] = useState<"todo" | "tools">("tools");
  const [isolate, setIsolate] = useState(
    () => localStorage.getItem("agentz-workz-isolate") === "1",
  );
  const [worktree, setWorktree] = useState<AgentTaskInfo | null>(null);
  const [reviewTask, setReviewTask] = useState<AgentTaskInfo | null>(null);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [activeTeam, setActiveTeam] = useState<string>("");
  const [activePoolId, setActivePoolId] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [workflowRunId, setWorkflowRunId] = useState<string | null>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const hasWorkflowTeam = useMemo(() => teams.some((tm) => tm.mode === "workflow"), [teams]);
  const activePoolRef = useRef<string | null>(null);
  activePoolRef.current = activePoolId;

  // Session ids of tasks currently running (foreground or background). Drives
  // the sidebar running indicators and whether the active task shows as busy.
  const [runningIds, setRunningIds] = useState<string[]>([]);

  const sessionRef = useRef<string | null>(null);
  const worktreeRef = useRef<AgentTaskInfo | null>(null);
  worktreeRef.current = worktree;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<(text: string, att: ChatAttachment | null) => Promise<void>>(async () => {});

  const {
    pendingCards,
    handleAgentEvent,
    markSubmitted,
    markActionSent,
    clearCards,
  } = useInteractiveCards();

  // ── Parallel task bookkeeping (M7) ──────────────────────────────────────
  // `live` gates whether incoming kernel events update the foreground view;
  // `foregroundSession` binds that view to a specific session id (null while a
  // brand-new task hasn't been assigned one yet). Background runs keep going
  // server-side under their own task key + cancel flag.
  const liveRef = useRef(false);
  const foregroundSessionRef = useRef<string | null>(null);
  const foregroundTaskKeyRef = useRef<string | null>(null);
  const runningSessionsRef = useRef<Set<string>>(new Set());
  const taskKeyBySessionRef = useRef<Map<string, string>>(new Map());

  const markRunning = useCallback((id: string | null, on: boolean) => {
    if (!id) return;
    const set = runningSessionsRef.current;
    if (on) set.add(id);
    else set.delete(id);
    setRunningIds(Array.from(set));
  }, []);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setLlmProviders(s.llm_providers ?? []);
        const label = s.model?.trim() ? `${s.provider}/${s.model}` : s.provider || "default";
        setDefaultModelLabel(label);
      })
      .catch(() => setLlmProviders([]));
  }, []);

  useEffect(() => {
    localStorage.setItem("agentz-model-id", modelId);
  }, [modelId]);

  useEffect(() => {
    listTeams()
      .then((list) => {
        setTeams(list);
        setActiveTeam((cur) => (cur && !list.some((tm) => tm.id === cur) ? "" : cur));
      })
      .catch(() => setTeams([]));
  }, []);

  // Reset pool binding when the team selection changes.
  useEffect(() => {
    setActivePoolId(null);
  }, [activeTeam, projectDir]);

  // Track the active workflow run's status so the reopen button reflects it.
  useEffect(() => {
    if (!workflowRunId) return;
    let unlisten: (() => void) | undefined;
    subscribeWorkflowEvents((e) => {
      if (e.runId === workflowRunId) setWorkflowStatus(e.status);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [workflowRunId]);

  useEffect(() => {
    localStorage.setItem("agentz-workz-isolate", isolate ? "1" : "0");
  }, [isolate]);

  const clearAttachment = useCallback(() => {
    setAttachment(null);
    if (attachmentPreview?.startsWith("blob:")) URL.revokeObjectURL(attachmentPreview);
    setAttachmentPreview(null);
  }, [attachmentPreview]);

  useEffect(() => {
    sessionRef.current = null;
    setSelectedId(null);
    setSteps([]);
    setTasks([]);
    setError(null);
    setGoal("");
    clearAttachment();
    setPreviewPath(null);
    setPlanItems([]);
    setToolSteps([]);
    setWorktree(null);
    setReviewTask(null);
    liveRef.current = false;
    foregroundSessionRef.current = null;
    foregroundTaskKeyRef.current = null;
    runningSessionsRef.current.clear();
    taskKeyBySessionRef.current.clear();
    setRunningIds([]);
    clearCards();
  }, [projectDir, clearAttachment, clearCards]);

  const refreshTasks = useCallback(() => {
    if (!projectDir) {
      setTasks([]);
      return;
    }
    listSessions(projectDir).then(setTasks).catch(() => setTasks([]));
  }, [projectDir]);

  const refreshChanges = useCallback(() => {
    if (!projectDir) {
      setChanges([]);
      return;
    }
    ideApi
      .gitStatus(projectDir)
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [projectDir]);

  useEffect(() => {
    refreshTasks();
    refreshChanges();
  }, [refreshTasks, refreshChanges]);

  // Stream kernel events into the in-flight step. The event channel is shared
  // with the IDE chat panel and with any background Agent tasks, so we only
  // consume events that belong to the foreground run: once a session id is
  // known we match on it; while a brand-new task is still session-less we
  // accept events that aren't claimed by another running session.
  const applyEvent = useCallback((env: ChatEventEnvelope) => {
    if (!liveRef.current) return;
    const fg = foregroundSessionRef.current;
    if (fg) {
      if (env.sessionId !== fg) return;
    } else if (env.sessionId && runningSessionsRef.current.has(env.sessionId)) {
      return;
    }
    if (env.channel === "agent_final") {
      const fin = env.payload as { ok: boolean; error?: string };
      if (!fin.ok && fin.error) setError(fin.error);
      return;
    }
    if (env.channel !== "agent_event") return;
    const evt = env.payload as AgentEvent;

    switch (evt.type) {
      case "text_delta":
        setSteps((prev) => {
          if (prev.length === 0) return prev;
          const copy = prev.slice();
          const last = { ...copy[copy.length - 1] };
          if (last.role !== "assistant") return prev;
          last.text += evt.delta;
          copy[copy.length - 1] = last;
          return copy;
        });
        break;
      case "tool_start":
        setTaskPanelOpen(true);
        setTaskPanelTab("tools");
        if (evt.name === "plan_todo") {
          const updates = parsePlanFromToolInput(evt.input);
          if (updates.length > 0) {
            const merge = Boolean((evt.input as { merge?: boolean })?.merge);
            setPlanItems((prev) => (merge ? mergePlanItems(prev, updates) : updates));
            setTaskPanelTab("todo");
          }
        }
        setToolSteps((prev) => [
          ...prev,
          {
            id: evt.id,
            name: evt.name,
            input: evt.input,
            completed: false,
            expanded: false,
          },
        ]);
        setSteps((prev) => {
          if (prev.length === 0) return prev;
          const copy = prev.slice();
          const last = { ...copy[copy.length - 1] };
          if (last.role !== "assistant") return prev;
          last.tools = applyToolStart(last.tools.slice(), evt);
          copy[copy.length - 1] = last;
          return copy;
        });
        break;
      case "tool_end":
        setToolSteps((prev) =>
          prev.map((step) =>
            step.id === evt.id
              ? {
                  ...step,
                  completed: true,
                  result: evt.result,
                  isError: evt.is_error,
                  expanded: false,
                }
              : step,
          ),
        );
        setSteps((prev) => {
          if (prev.length === 0) return prev;
          const copy = prev.slice();
          const last = { ...copy[copy.length - 1] };
          if (last.role !== "assistant") return prev;
          last.tools = applyToolEnd(last.tools.slice(), evt);
          copy[copy.length - 1] = last;
          return copy;
        });
        break;
      case "plan_update":
        setPlanItems(evt.items);
        setTaskPanelOpen(true);
        setTaskPanelTab("todo");
        break;
      case "error":
        setSteps((prev) => {
          if (prev.length === 0) return prev;
          const copy = prev.slice();
          const last = { ...copy[copy.length - 1] };
          if (last.role !== "assistant") return prev;
          last.text += `\n\n⚠️ ${evt.message}`;
          copy[copy.length - 1] = last;
          return copy;
        });
        break;
      default:
        handleAgentEvent(evt);
        break;
    }
  }, [handleAgentEvent]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onChatEvent(applyEvent).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [applyEvent]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [steps]);

  runRef.current = async (text: string, att: ChatAttachment | null) => {
    setError(null);
    const displayText =
      att && !text.trim()
        ? `📎 ${att.filename ?? att.path ?? t("chat.attachment")}`
        : att
          ? `${text}${text.trim() ? "\n" : ""}📎 ${att.filename ?? att.path ?? t("chat.attachment")}`
          : text;
    setSteps((s) => [
      ...s,
      { role: "user", text: displayText, tools: [] },
      { role: "assistant", text: "", tools: [] },
    ]);
    setToolSteps([]);
    setPlanItems([]);
    setBusy(true);

    // Each turn gets a unique task key so Stop and the concurrency queue can
    // target it independently of any sibling task running in the background.
    const taskKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startSession = sessionRef.current;
    liveRef.current = true;
    foregroundSessionRef.current = startSession;
    foregroundTaskKeyRef.current = taskKey;
    if (startSession) {
      markRunning(startSession, true);
      taskKeyBySessionRef.current.set(startSession, taskKey);
    }

    const isForeground = () => foregroundTaskKeyRef.current === taskKey;

    try {
      // Isolated run: create a dedicated worktree + branch on first turn, then
      // keep the agent working inside it for the rest of the task.
      let wt = worktreeRef.current;
      if (isolate && !wt) {
        try {
          const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          wt = await agentTaskApi.create(projectDir!, taskId);
          setWorktree(wt);
        } catch (e) {
          setError(String(e));
          setBusy(false);
          liveRef.current = false;
          return;
        }
      }
      // Team mode: ensure a Pool exists for the selected team, then instruct the
      // agent to orchestrate its members via the pool tools.
      let effectivePrompt = text;
      if (activeTeam) {
        try {
          let poolId = activePoolRef.current;
          if (!poolId) {
            const created = await createPoolFromTeam(projectDir!, activeTeam);
            poolId = created.pool_id;
            setActivePoolId(poolId);
            activePoolRef.current = poolId;
          }
          // Only establish the coordinator role + org_spec on the first turn of a
          // session; follow-up messages stay raw so the contract isn't repeated
          // (the first-turn instruction persists in the session history).
          if (!startSession) {
            const orgSpec = teams.find((tm) => tm.id === activeTeam)?.org_spec?.trim();
            const orgSection = orgSpec
              ? `\n\nYour team operates under this organization contract (org_spec); ` +
                `every member Koi receives it too, so hold yourself and them to it:\n${orgSpec}`
              : "";
            effectivePrompt =
              `You are the coordinator of team pool "${activeTeam}" (pool_id: ${poolId}). ` +
              `Use the pool_org and pool_chat tools to break this down into todos, assign them ` +
              `to member Koi, and integrate their results.${orgSection}\n\nTask:\n${text}`;
          }
        } catch (e) {
          setError(String(e));
        }
      }
      const res = await chatSend({
        prompt: effectivePrompt,
        sessionId: startSession,
        projectDir: projectDir!,
        workspaceDir: wt?.worktree_path ?? null,
        attachment: att,
        chatMode: "agent",
        modelId: modelId || null,
        taskKey,
      });
      // Bind the (possibly newly created) session id to this run.
      taskKeyBySessionRef.current.set(res.session_id, taskKey);
      if (!startSession) markRunning(res.session_id, true);
      if (isForeground()) {
        sessionRef.current = res.session_id;
        foregroundSessionRef.current = res.session_id;
        setSelectedId(res.session_id);
        setSteps((s) => {
          const copy = s.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant" && !last.text.trim()) {
            copy[copy.length - 1] = { ...last, text: res.response_text };
          }
          return copy;
        });
      }
    } catch (e) {
      if (isForeground()) setError(String(e));
    } finally {
      const sid = sessionRef.current ?? foregroundSessionRef.current;
      markRunning(startSession, false);
      if (sid) markRunning(sid, false);
      if (isForeground()) {
        setBusy(false);
        liveRef.current = false;
        setSteps((s) =>
          s.map((step) =>
            step.role === "assistant" ? { ...step, tools: finalizeTools(step.tools) } : step,
          ),
        );
      }
      refreshTasks();
      refreshChanges();
    }
  };

  const run = useCallback(() => {
    const text = goal.trim();
    if ((!text && !attachment) || busy) return;
    if (!projectDir) {
      setError(t("agent.noProject"));
      return;
    }
    // Workflow teams run a deterministic graph (no chat turn / coordinator).
    const teamInfo = teams.find((tm) => tm.id === activeTeam);
    if (activeTeam && teamInfo?.mode === "workflow") {
      setGoal("");
      setError(null);
      setWorkflowStatus("running");
      startWorkflow(projectDir, activeTeam, text)
        .then((started) => {
          setWorkflowRunId(started.run_id);
          setWorkflowOpen(true);
        })
        .catch((e) => setError(String(e)));
      return;
    }
    const pendingAttachment = attachment;
    setGoal("");
    clearAttachment();
    void runRef.current(text, pendingAttachment);
  }, [goal, attachment, busy, projectDir, clearAttachment, t, teams, activeTeam]);

  const newTask = useCallback(() => {
    if (!projectDir) return;
    // Detach the current view from any in-flight run — it keeps going in the
    // background and resurfaces in the task list when it finishes.
    liveRef.current = false;
    foregroundSessionRef.current = null;
    foregroundTaskKeyRef.current = null;
    setBusy(false);
    sessionRef.current = null;
    setSelectedId(null);
    setSteps([]);
    setPlanItems([]);
    setToolSteps([]);
    setError(null);
    setGoal("");
    clearAttachment();
    setWorktree(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [projectDir, clearAttachment]);

  const openTask = useCallback(
    async (id: string) => {
      if (!projectDir) return;
      try {
        const history = await getMessages(id, projectDir);
        // Switching away detaches live streaming from the previous foreground
        // run (it continues in the background). We show this task's persisted
        // history; if it is itself running, results refresh on completion.
        liveRef.current = false;
        foregroundTaskKeyRef.current = null;
        foregroundSessionRef.current = id;
        sessionRef.current = id;
        setBusy(runningSessionsRef.current.has(id));
        setSelectedId(id);
        setSteps(history.map((m) => ({ id: m.id, role: m.role, text: m.content, tools: [] })));
        setPlanItems([]);
        setToolSteps([]);
        setError(null);
        setPreviewPath(null);
        refreshChanges();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectDir, refreshChanges],
  );

  // Cancel the task bound to the active view (foreground run, or a reopened
  // background run we still hold the key for).
  const stopActive = useCallback(() => {
    const sid = sessionRef.current;
    const key =
      foregroundTaskKeyRef.current ??
      (sid ? taskKeyBySessionRef.current.get(sid) ?? null : null);
    void chatCancel(key);
  }, []);

  const removeTask = useCallback(
    async (id: string) => {
      if (!projectDir) return;
      try {
        await deleteSession(id, projectDir);
        markRunning(id, false);
        taskKeyBySessionRef.current.delete(id);
        if (sessionRef.current === id) newTask();
        refreshTasks();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectDir, newTask, refreshTasks, markRunning],
  );

  const buildWiki = useCallback(async () => {
    if (!projectDir || wikiBusy) return;
    setWikiBusy(true);
    onWikiBusyChange?.(true);
    setError(null);
    try {
      const res = await generateRepoWiki(projectDir);
      setPreviewPath(res.path);
    } catch (e) {
      setError(String(e));
    } finally {
      setWikiBusy(false);
      onWikiBusyChange?.(false);
    }
  }, [projectDir, wikiBusy, onWikiBusyChange]);

  const wikiTriggerRef = useRef(0);
  useEffect(() => {
    if (wikiBuildNonce <= 0 || wikiBuildNonce === wikiTriggerRef.current) return;
    wikiTriggerRef.current = wikiBuildNonce;
    void buildWiki();
  }, [wikiBuildNonce, buildWiki]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  };

  const handleAttach = useCallback(async () => {
    try {
      const picked = await pickChatAttachment();
      if (!picked) return;
      if (attachmentPreview?.startsWith("blob:")) URL.revokeObjectURL(attachmentPreview);
      setAttachment(picked.attachment);
      setAttachmentPreview(picked.preview);
    } catch (e) {
      setError(String(e));
    }
  }, [attachmentPreview]);

  const modelOptions = useMemo((): ComposerMenuOption[] => {
    const opts: ComposerMenuOption[] = [
      { id: "", label: defaultModelLabel || t("chat.modelDefault"), hint: t("chat.modelDefault") },
    ];
    for (const p of llmProviders) {
      opts.push({
        id: p.id,
        label: p.model || modelLabel(p),
        hint: modelLabel(p),
      });
    }
    return opts;
  }, [llmProviders, defaultModelLabel, t]);

  const toggleToolStep = useCallback((id: string) => {
    setToolSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, expanded: !step.expanded } : step)),
    );
  }, []);

  const canSend = Boolean(projectDir && (goal.trim() || attachment));
  const artifacts = useMemo(() => collectArtifacts(steps, changes), [steps, changes]);

  return (
    <div className="agentz-agent">
      <aside className="agentz-workz-sidebar">
        <div className="agentz-workz-sidebar-head">
          <span>{t("agent.tasks")}</span>
          <button
            onClick={newTask}
            disabled={!projectDir}
            title={!projectDir ? t("agent.noProject") : t("agent.newTask")}
          >
            ＋ {t("agent.new")}
          </button>
        </div>
        <div className="agentz-workz-tasklist">
          {tasks.length === 0 && <div className="agentz-workz-tasks-empty">{t("agent.noTasks")}</div>}
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`agentz-workz-task ${task.id === selectedId ? "active" : ""} ${runningIds.includes(task.id) ? "running" : ""}`}
              onClick={() => void openTask(task.id)}
            >
              <span
                className={`agentz-workz-task-dot ${runningIds.includes(task.id) ? "running" : task.status}`}
              />
              <span className="agentz-workz-task-title">{task.title || t("agent.untitled")}</span>
              <span className="agentz-workz-task-count">{task.message_count}</span>
              <button
                className="agentz-workz-task-del"
                title={t("agent.deleteTask")}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeTask(task.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="agentz-workz-main">
        <div className={`agentz-workz-content${previewPath ? " has-preview" : ""}`}>
          <div className="agentz-workz-steps-wrap">
            <ArtifactsDrawer
              artifacts={artifacts}
              activePath={previewPath}
              pinned={previewPath != null}
              onSelect={(path) => setPreviewPath(path)}
            />
            <div className="agentz-workz-steps" ref={scrollRef}>
          {steps.length === 0 && (
            <div className="agentz-workz-empty">
              <div className="agentz-workz-title">{t("agent.title")}</div>
              <p className="agentz-workz-sub">
                {t("agent.subtitle", {
                  project: projectDir || t("agent.openProjectFallback"),
                })}
              </p>
              {!projectDir && (
                <>
                  <p className="agentz-workz-note">{t("agent.noProject")}</p>
                  <button type="button" className="agentz-workz-open-folder" onClick={onOpenFolder}>
                    {t("app.openFolder")}
                  </button>
                </>
              )}
            </div>
          )}
          {steps.map((m, i) => {
            const isStreamingLast = m.role === "assistant" && busy && i === steps.length - 1;
            return (
              <div key={m.id ?? `step-${i}`} className={`agentz-workz-msg ${m.role}`}>
                <div className="agentz-workz-msg-role">
                  {m.role === "user" ? t("chat.you") : t("agent.role")}
                </div>
                <div className="agentz-workz-msg-body">
                  {m.text ? (
                    <div className="agentz-workz-msg-bubble">
                      {m.role === "assistant" ? (
                        <Markdown content={m.text} />
                      ) : (
                        <div className="agentz-workz-msg-text">{m.text}</div>
                      )}
                    </div>
                  ) : isStreamingLast ? (
                    <div className="agentz-workz-msg-bubble agentz-workz-msg-thinking">
                      {t("agent.working")}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {pendingCards.map((card) => (
            <div key={card.requestId} className="agentz-workz-msg assistant">
              <div className="agentz-workz-msg-role">{t("agent.role")}</div>
              <div className="agentz-workz-msg-body">
                <InteractiveCard
                  requestId={card.requestId}
                  uiDefinition={card.uiDefinition}
                  listenOpen={card.listenOpen}
                  wizardStepHint={card.wizardStepHint}
                  onSubmitted={() => markSubmitted(card.requestId)}
                  onActionSent={() => markActionSent(card.requestId)}
                />
              </div>
            </div>
          ))}
            </div>
          </div>
          {previewPath && projectDir && (
            <AgentFilePreview
              projectDir={projectDir}
              path={previewPath}
              onClose={() => setPreviewPath(null)}
            />
          )}
        </div>

        {error && <div className="agentz-workz-error">{error}</div>}

        <TaskPanel
          className="agentz-workz-task-panel"
          planItems={planItems}
          toolSteps={toolSteps}
          busy={busy}
          open={taskPanelOpen}
          onOpenChange={setTaskPanelOpen}
          tab={taskPanelTab}
          onTabChange={setTaskPanelTab}
          onToggleToolStep={toggleToolStep}
        />

        <div className="agentz-workz-isolate-bar">
          <label
            className="agentz-workz-isolate-toggle"
            title={t("agent.isolateHint")}
          >
            <input
              type="checkbox"
              checked={isolate}
              disabled={busy}
              onChange={(e) => setIsolate(e.target.checked)}
            />
            <span>{isolate ? t("agent.isolateOn") : t("agent.isolateOff")}</span>
          </label>
          {teams.length > 0 && (
            <label className="agentz-workz-team-select" title={t("agent.teamHint")}>
              <span>{t("agent.team")}</span>
              <select
                value={activeTeam}
                disabled={busy}
                onChange={(e) => setActiveTeam(e.target.value)}
              >
                <option value="">{t("agent.teamNone")}</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {activePoolId && (
            <button
              type="button"
              className="agentz-workz-review-btn"
              onClick={() => setBoardOpen(true)}
            >
              {t("collab.openBoard")}
            </button>
          )}
          {workflowRunId && (
            <button
              type="button"
              className="agentz-workz-review-btn"
              onClick={() => setWorkflowOpen(true)}
            >
              {t("workflow.designer")}
              {workflowStatus ? ` · ${t(`workflow.status.${workflowStatus}`)}` : ""}
            </button>
          )}
          {hasWorkflowTeam && (
            <button
              type="button"
              className="agentz-workz-review-btn"
              onClick={() => setRunsOpen(true)}
            >
              {t("workflow.openHistory")}
            </button>
          )}
          {worktree && (
            <button
              type="button"
              className="agentz-workz-review-btn"
              onClick={() => setReviewTask(worktree)}
              disabled={busy}
              title={worktree.branch}
            >
              {t("agent.review")}
            </button>
          )}
        </div>

        <div className={`agentz-workz-changes${changesOpen ? " expanded" : ""}`}>
          <div className="agentz-workz-changes-head">
            <button
              type="button"
              className="agentz-workz-changes-toggle"
              onClick={() => setChangesOpen((v) => !v)}
              aria-expanded={changesOpen}
            >
              <span>
                {t("agent.changes")}
                {changes.length > 0 ? ` (${changes.length})` : ""}
              </span>
              <span className="agentz-workz-changes-chevron">{changesOpen ? "▾" : "▸"}</span>
            </button>
            <button
              type="button"
              className="agentz-workz-changes-refresh"
              onClick={() => void refreshChanges()}
              disabled={!projectDir}
              title={t("agent.refreshGit")}
            >
              ⟳
            </button>
          </div>
          {changesOpen && (
            changes.length === 0 ? (
              <div className="agentz-workz-changes-empty">{t("agent.noChanges")}</div>
            ) : (
              <div className="agentz-workz-changes-list">
                {changes.map((c) => (
                  <button
                    key={c.path}
                    type="button"
                    className="agentz-workz-change"
                    onClick={() => projectDir && setPreviewPath(c.path)}
                  >
                    <span className={`agentz-workz-change-badge ${c.status}`}>
                      {c.status.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="agentz-workz-change-path">{c.path}</span>
                  </button>
                ))}
              </div>
            )
          )}
        </div>

        <ChatComposer
          value={goal}
          onChange={setGoal}
          onSubmit={run}
          onStop={stopActive}
          busy={busy}
          placeholder={
            !projectDir
              ? t("agent.noProject")
              : busy
                ? t("agent.placeholderBusy")
                : t("agent.placeholder")
          }
          canSend={canSend}
          inputDisabled={!projectDir}
          textareaRef={taRef}
          onKeyDown={onKeyDown}
          modelId={modelId}
          modelOptions={modelOptions}
          onModelChange={setModelId}
          attachment={attachment}
          attachmentPreview={attachmentPreview}
          onAttach={() => void handleAttach()}
          onClearAttachment={clearAttachment}
          attachTitle={t("chat.attachFile")}
          removeAttachmentTitle={t("chat.removeAttachment")}
          stopTitle={t("agent.stop")}
          sendTitle={t("agent.run")}
        />
      </section>
      {boardOpen && activePoolId && projectDir && (
        <CollabBoard
          projectDir={projectDir}
          poolId={activePoolId}
          onClose={() => setBoardOpen(false)}
        />
      )}
      {workflowOpen && workflowRunId && (
        <WorkflowRunPanel
          runId={workflowRunId}
          onClose={() => setWorkflowOpen(false)}
          onRerun={(id) => {
            setWorkflowRunId(id);
            setWorkflowStatus("running");
          }}
        />
      )}
      {runsOpen && (
        <WorkflowRunsList
          teamId={activeTeam || null}
          onSelect={(id) => {
            setWorkflowRunId(id);
            setWorkflowStatus(null);
            setWorkflowOpen(true);
            setRunsOpen(false);
          }}
          onClose={() => setRunsOpen(false)}
        />
      )}
      {reviewTask && projectDir && (
        <AgentTaskReview
          projectDir={projectDir}
          task={reviewTask}
          onClose={() => setReviewTask(null)}
          onResolved={() => {
            refreshChanges();
            refreshTasks();
          }}
        />
      )}
    </div>
  );
}
