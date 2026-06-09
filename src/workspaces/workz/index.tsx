import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  chatSend,
  chatCancel,
  onChatEvent,
  listSessions,
  SESSION_SOURCE_WORKZ,
  SESSION_SOURCE_WORKZ_TEAM,
  getMessages,
  deleteSession,
  journalListChanges,
  type AgentEvent,
  type ChatAttachment,
  type ChatEventEnvelope,
  type PlanTodoItem,
  type SessionMeta,
} from "../../services/tauri/chat";
import { useAppSettings, pruneModelId } from "../../hooks/useAppSettings";
import { loadScopedModelId, saveScopedModelId } from "../../utils/modelPrefs";
import { useInputHistory } from "../../components/useInputHistory";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { agentTaskApi, type AgentTaskInfo } from "../../services/tauri/agentTask";
import { generateRepoWiki } from "../../services/tauri/repoWiki";
import AgentTaskReview from "./AgentTaskReview";
import SessionSkillRevisions from "./SessionSkillRevisions";
import ChatComposer, { type ComposerMenuOption } from "../../components/ChatComposer";
import DropdownSelect, { type DropdownOption } from "../../components/DropdownSelect";
import {
  modelLabel,
  modelDisplayLabel,
  pickChatAttachment,
  attachmentFromPath,
  blobToDataUrl,
  dataUrlToBase64,
} from "../../components/chatComposerUtils";
import { visionCapable } from "../../components/visionUtils";
import TaskPanel, {
  mergePlanItems,
  parsePlanFromToolInput,
  upsertToolStep,
  type ToolStep,
} from "../../components/TaskPanel";
import Markdown from "../codez/Markdown";
import InteractiveCard from "../../components/chat/InteractiveCard";
import { useInteractiveCards } from "../../hooks/useInteractiveCards";
import AgentFilePreview from "./AgentFilePreview";
import { useProjectEdge } from "../../contexts/ProjectEdgeContext";
import CollabBoard from "./CollabBoard";
import PoolActivityFeed from "./PoolActivityFeed";
import WorkflowRunPanel from "./WorkflowRunPanel";
import WorkflowRunsList from "./WorkflowRunsList";
import { listTeams, createPoolFromTeam, type TeamInfo } from "../../services/tauri/teams";
import { listAgents, type AgentInfo } from "../../services/tauri/agents";
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
import { taskDisplayTitle, workzGoalFromText } from "./taskTitle";
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
  const {
    gitChanges,
    setArtifacts,
    setPreviewPath,
    previewPath,
    refreshGitChanges,
    setPendingReview,
  } = useProjectEdge();
  const [tasks, setTasks] = useState<SessionMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [wikiBusy, setWikiBusy] = useState(false);
  const [modelId, setModelId] = useState(() => loadScopedModelId("workz"));
  const { appSettings, llmProviders, defaultModelLabel, defaultModelHint } = useAppSettings();
  const inputHistory = useInputHistory("agentz-input-history-workz");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>(
    () => localStorage.getItem("agentz-workz-agent") ?? "",
  );
  const [activePoolId, setActivePoolId] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [workflowRunId, setWorkflowRunId] = useState<string | null>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [swarmMainTab, setSwarmMainTab] = useState<"main" | "chatroom" | "coordination">("main");

  /** All WorkZ user tasks — sidebar lists single-agent and team sessions together. */
  const workzTaskSources = useMemo(
    () => [SESSION_SOURCE_WORKZ, SESSION_SOURCE_WORKZ_TEAM],
    [],
  );
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
  const panelRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<(text: string, att: ChatAttachment | null) => Promise<void>>(async () => {});

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

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
    saveScopedModelId("workz", modelId);
  }, [modelId]);

  useEffect(() => {
    setModelId((id) => pruneModelId(id, llmProviders));
  }, [llmProviders]);

  useEffect(() => {
    listTeams()
      .then((list) => {
        setTeams(list);
        setActiveTeam((cur) => (cur && !list.some((tm) => tm.id === cur) ? "" : cur));
      })
      .catch(() => setTeams([]));
    listAgents()
      .then((list) => {
        setAgents(list);
        setActiveAgentId((cur) => (cur && !list.some((a) => a.id === cur) ? "" : cur));
      })
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    localStorage.setItem("agentz-workz-agent", activeAgentId);
  }, [activeAgentId]);

  // Swarm team selected → materialise/reuse the pool immediately so the
  // collaboration board is available before the first coordinator turn
  // (workflow「历史」is team-scoped the same way).
  useEffect(() => {
    if (!projectDir || !activeTeam) return;
    const team = teams.find((tm) => tm.id === activeTeam);
    if (team?.mode !== "swarm") return;

    let cancelled = false;
    createPoolFromTeam(projectDir, activeTeam)
      .then((created) => {
        if (!cancelled) {
          setActivePoolId(created.pool_id);
          activePoolRef.current = created.pool_id;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [projectDir, activeTeam, teams]);

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
    listSessions(projectDir, workzTaskSources, null)
      .then(setTasks)
      .catch(() => setTasks([]));
  }, [projectDir, workzTaskSources]);

  /** True once a task session (or workflow run) is bound — mode pickers lock. */
  const taskBound = selectedId !== null || workflowRunId !== null;

  const applyTaskModeBinding = useCallback((meta: SessionMeta | undefined) => {
    const boundTeam = meta?.team_id?.trim() ?? "";
    setActiveTeam(boundTeam);
    setSwarmMainTab("main");
    if (meta?.pool_id) {
      setActivePoolId(meta.pool_id);
      activePoolRef.current = meta.pool_id;
    } else {
      setActivePoolId(null);
      activePoolRef.current = null;
    }
  }, []);

  const handleTeamChange = useCallback(
    (teamId: string) => {
      if (taskBound) return;
      setSwarmMainTab("main");
      setActivePoolId(null);
      activePoolRef.current = null;
      setActiveTeam(teamId);
    },
    [taskBound],
  );

  const handleAgentChange = useCallback(
    (agentId: string) => {
      if (taskBound) return;
      setActiveAgentId(agentId);
    },
    [taskBound],
  );

  useEffect(() => {
    refreshTasks();
    refreshGitChanges();
  }, [refreshTasks, refreshGitChanges]);

  useEffect(() => {
    setArtifacts(collectArtifacts(steps, gitChanges));
  }, [steps, gitChanges, setArtifacts]);

  // Stream kernel events into the in-flight step. The event channel is shared
  // with the IDE chat panel and with any background Agent tasks, so we only
  // consume events that belong to the foreground run: once a session id is
  // known we match on it; while a brand-new task is still session-less we
  // accept events that aren't claimed by another running session.
  const applyEvent = useCallback((env: ChatEventEnvelope) => {
    if (env.channel === "session_title" && env.sessionId) {
      const title = (env.payload as { title?: string }).title;
      if (title) {
        setTasks((prev) => {
          const idx = prev.findIndex((task) => task.id === env.sessionId);
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = { ...next[idx], title };
          return next;
        });
      }
      return;
    }
    // Turn completion must update every session — including background runs
    // after the user clicks「新建」— or the sidebar dot stays yellow forever.
    if (env.channel === "agent_final") {
      const fin = env.payload as { ok: boolean; error?: string };
      const fg = foregroundSessionRef.current;
      if (liveRef.current && fg && env.sessionId === fg && !fin.ok && fin.error) {
        setError(fin.error);
      }
      markRunning(env.sessionId, false);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === env.sessionId ? { ...t, status: fin.ok ? "idle" : "error" } : t,
        ),
      );
      return;
    }

    if (!liveRef.current) return;
    // The kernel multiplexes every session (coordinator turn + each member
    // Koi turn) onto one channel. Apply only events for the bound foreground
    // session; the id is always known up front now (pre-generated for new
    // tasks), so anything else — broadcasts included — is dropped.
    const fg = foregroundSessionRef.current;
    if (!fg || env.sessionId !== fg) return;
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
        setToolSteps((prev) => upsertToolStep(prev, evt));
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
  }, [handleAgentEvent, markRunning]);

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
    // Continue the open task's session — never spawn a sibling row on follow-up.
    const startSession = sessionRef.current ?? selectedId;
    if (startSession) {
      sessionRef.current = startSession;
    }
    // Pre-generate the session id for a brand-new task so the sidebar can
    // select it, show the running indicator, and (critically) the event
    // stream can be filtered to *this* session immediately — otherwise
    // member-Koi turns sharing the event channel leak into the view while the
    // turn is session-less. The backend honours a client-provided id.
    const effectiveSessionId = startSession ?? crypto.randomUUID();
    liveRef.current = true;
    foregroundSessionRef.current = effectiveSessionId;
    foregroundTaskKeyRef.current = taskKey;
    sessionRef.current = effectiveSessionId;
    taskKeyBySessionRef.current.set(effectiveSessionId, taskKey);
    markRunning(effectiveSessionId, true);
    setSelectedId(effectiveSessionId);
    if (!startSession) {
      // Optimistically surface the new task in the sidebar; refreshTasks()
      // reconciles it (real title / status) once the turn finishes.
      const optimistic: SessionMeta = {
        id: effectiveSessionId,
        title: workzGoalFromText(text) || text.trim().slice(0, 60) || t("agent.untitled"),
        status: "running",
        message_count: 1,
        updated_at: new Date().toISOString(),
        source: activeTeam ? SESSION_SOURCE_WORKZ_TEAM : SESSION_SOURCE_WORKZ,
        team_id: activeTeam || null,
        pool_id: activePoolRef.current,
      };
      setTasks((prev) =>
        prev.some((p) => p.id === effectiveSessionId) ? prev : [optimistic, ...prev],
      );
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
          // Re-sync member agent models into kois on every task start (idempotent pool).
          const created = await createPoolFromTeam(projectDir!, activeTeam);
          const poolId = created.pool_id;
          setActivePoolId(poolId);
          activePoolRef.current = poolId;
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
        displayPrompt: text,
        sessionId: effectiveSessionId,
        projectDir: projectDir!,
        workspaceDir: wt?.worktree_path ?? null,
        attachment: att,
        chatMode: "agent",
        modelId: showModelSelector ? modelId || null : null,
        taskKey,
        // Single-agent mode: run as the chosen persona. Team mode uses the
        // coordinator path, so no per-agent persona is applied there.
        agentId: activeTeam ? null : activeAgentId || null,
        sessionSource: activeTeam ? SESSION_SOURCE_WORKZ_TEAM : SESSION_SOURCE_WORKZ,
        teamId: activeTeam || null,
        poolId: activePoolRef.current,
      });
      // The backend echoes the (pre-generated) session id; keep the maps in
      // sync in case it ever differs, then fold in the final assistant text.
      if (res.session_id !== effectiveSessionId) {
        taskKeyBySessionRef.current.set(res.session_id, taskKey);
        markRunning(res.session_id, true);
      }
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
        if (res.turn_id && projectDir) {
          try {
            const journalChanges = await journalListChanges(
              projectDir,
              res.session_id,
              res.turn_id,
            );
            setPendingReview(
              journalChanges.length > 0
                ? {
                    sessionId: res.session_id,
                    turnId: res.turn_id,
                    changes: journalChanges,
                  }
                : null,
            );
          } catch {
            /* journal is best-effort */
          }
        }
      }
    } catch (e) {
      if (isForeground()) setError(String(e));
    } finally {
      // Clear the running flag for *this* run's own session — never the
      // session the user may have navigated to in the meantime.
      markRunning(effectiveSessionId, false);
      if (startSession && startSession !== effectiveSessionId) {
        markRunning(startSession, false);
      }
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
      refreshGitChanges();
    }
  };

  const run = useCallback(() => {
    const text = goal.trim();
    if ((!text && !attachment) || busy) return;
    if (!projectDir) {
      setError(t("agent.noProject"));
      return;
    }
    if (text) inputHistory.push(text);
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
  }, [goal, attachment, busy, projectDir, clearAttachment, inputHistory, t, teams, activeTeam]);

  const newTask = useCallback(() => {
    if (!projectDir) return;
    // Detach the current view from any in-flight run — it keeps going in the
    // background and resurfaces in the task list when it finishes. Clearing
    // the session binding unlocks team / agent mode pickers for the next task.
    liveRef.current = false;
    foregroundSessionRef.current = null;
    foregroundTaskKeyRef.current = null;
    setBusy(false);
    sessionRef.current = null;
    setSelectedId(null);
    setWorkflowRunId(null);
    setWorkflowStatus(null);
    setSteps([]);
    setPlanItems([]);
    setToolSteps([]);
    setError(null);
    setGoal("");
    clearAttachment();
    setWorktree(null);
    // Land on the main chat so a fresh task is visibly empty (instead of the
    // previous run's Koi chatroom / coordination view lingering).
    setSwarmMainTab("main");
    requestAnimationFrame(() => taRef.current?.focus());
  }, [projectDir, clearAttachment]);

  const openTask = useCallback(
    async (id: string) => {
      if (!projectDir) return;
      // Clicking the session that is already the live foreground run must not
      // wipe its streaming tool calls / detach the stream — that was the
      // "in-progress tools vanish on click" bug. It's already on screen.
      if (id === foregroundSessionRef.current && liveRef.current) {
        setSelectedId(id);
        return;
      }
      try {
        const meta = tasks.find((task) => task.id === id);
        applyTaskModeBinding(meta);
        const history = await getMessages(id, projectDir);
        // Switching to a different task detaches live streaming from the
        // previous foreground run (it keeps going in the background). We show
        // the opened task's persisted history; if it is itself running, its
        // results refresh on completion.
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
        refreshGitChanges();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectDir, refreshGitChanges, tasks, applyTaskModeBinding],
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
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const next = inputHistory.navigate(e.key === "ArrowUp" ? "up" : "down", goal);
      if (next !== null) {
        e.preventDefault();
        setGoal(next);
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          const pos = next.length;
          ta.setSelectionRange(pos, pos);
        });
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  };

  // Set the (single) attachment, guarding images behind a vision-capable model
  // so we never silently drop an image the model can't read. Returns false when
  // rejected (caller may show its own feedback).
  const acceptAttachment = useCallback(
    (att: ChatAttachment, preview: string | null): boolean => {
      if (att.media_type.startsWith("image/")) {
        if (!appSettings || !visionCapable(appSettings, modelId, llmProviders)) {
          showToast(t("chat.visionRequired"));
          return false;
        }
      }
      if (attachmentPreview?.startsWith("blob:")) URL.revokeObjectURL(attachmentPreview);
      setAttachment(att);
      setAttachmentPreview(preview);
      return true;
    },
    [appSettings, modelId, llmProviders, attachmentPreview, showToast, t],
  );

  const handleAttach = useCallback(async () => {
    try {
      const picked = await pickChatAttachment();
      if (!picked) return;
      acceptAttachment(picked.attachment, picked.preview);
    } catch (e) {
      setError(String(e));
    }
  }, [acceptAttachment]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        try {
          const dataUrl = await blobToDataUrl(file);
          const data = dataUrlToBase64(dataUrl);
          acceptAttachment(
            {
              media_type: file.type || "image/png",
              data,
              filename: file.name || "paste.png",
              path: null,
            },
            dataUrl,
          );
        } catch (err) {
          setError(String(err));
        }
        return;
      }
    },
    [acceptAttachment],
  );

  // OS file drag-and-drop → attach the dropped file (image goes to vision when
  // the model supports it; other types are passed by path). Tauri captures
  // native file drops at the webview level, so we subscribe to that stream and
  // only react when the pointer is over this panel (mirrors the IDE chat).
  const applyDroppedPaths = useCallback(
    async (paths: string[]) => {
      const first = paths.find((p) => p.trim());
      if (!first) return;
      try {
        const built = await attachmentFromPath(first);
        if (acceptAttachment(built.attachment, built.preview)) {
          taRef.current?.focus();
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [acceptAttachment],
  );

  useEffect(() => {
    const pointInPanel = (x: number, y: number) => {
      const el = panelRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cx = x / dpr;
      const cy = y / dpr;
      return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
    };
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") {
          setDragOver(pointInPanel(p.position.x, p.position.y));
        } else if (p.type === "drop") {
          const over = pointInPanel(p.position.x, p.position.y);
          setDragOver(false);
          if (over && p.paths.length > 0) void applyDroppedPaths(p.paths);
        } else {
          setDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyDroppedPaths]);

  const modelOptions = useMemo((): ComposerMenuOption[] => {
    const opts: ComposerMenuOption[] = [
      {
        id: "",
        label: defaultModelLabel || t("chat.modelDefault"),
        hint: defaultModelHint || t("chat.modelDefault"),
      },
    ];
    for (const p of llmProviders) {
      opts.push({
        id: p.id,
        label: modelDisplayLabel(p),
        hint: modelLabel(p),
      });
    }
    return opts;
  }, [llmProviders, defaultModelLabel, defaultModelHint, t]);

  const toggleToolStep = useCallback((id: string) => {
    setToolSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, expanded: !step.expanded } : step)),
    );
  }, []);

  const canSend = Boolean(projectDir && (goal.trim() || attachment));
  const selectedTeam = useMemo(
    () => teams.find((tm) => tm.id === activeTeam),
    [teams, activeTeam],
  );
  const isSwarmTeam = selectedTeam?.mode === "swarm";
  const isWorkflowTeam = selectedTeam?.mode === "workflow";
  /** UI model picker only applies to single-agent + generic persona (no team, no named agent). */
  const showModelSelector = !activeTeam && !activeAgentId;
  const composerModeNotice = useMemo(() => {
    if (taskBound) return t("agent.modeLocked");
    if (activeTeam) {
      return isWorkflowTeam ? t("agent.modelWorkflowTeam") : t("agent.modelSwarmTeam");
    }
    if (activeAgentId) return t("agent.modelBoundAgent");
    return null;
  }, [taskBound, activeTeam, activeAgentId, isWorkflowTeam, t]);

  const teamOptions = useMemo((): DropdownOption[] => {
    const opts: DropdownOption[] = [{ id: "", label: t("agent.teamNone") }];
    for (const tm of teams) {
      opts.push({ id: tm.id, label: tm.name });
    }
    return opts;
  }, [teams, t]);

  const agentOptions = useMemo((): DropdownOption[] => {
    const opts: DropdownOption[] = [{ id: "", label: t("agent.agentGeneric") }];
    for (const a of agents) {
      opts.push({
        id: a.id,
        label: `${a.icon ? `${a.icon} ` : ""}${a.name}`,
      });
    }
    return opts;
  }, [agents, t]);

  return (
    <div className="agentz-agent" ref={panelRef}>
      {dragOver && (
        <div className="agentz-workz-dropzone">
          <span>{t("chat.dropToAttach")}</span>
        </div>
      )}
      {toast && <div className="agentz-workz-toast">{toast}</div>}
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
              <span className="agentz-workz-task-title">
                {taskDisplayTitle(task.title, t("agent.untitled"))}
              </span>
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
        <SessionSkillRevisions sessionId={selectedId} />
      </aside>

      <section className="agentz-workz-main">
        <div className={`agentz-workz-content${previewPath ? " has-preview" : ""}`}>
          <div className="agentz-workz-steps-wrap">
            {isSwarmTeam && projectDir && (
              <div className="agentz-workz-swarm-tabs">
                <button
                  type="button"
                  className={`agentz-workz-swarm-tab${swarmMainTab === "main" ? " active" : ""}`}
                  onClick={() => setSwarmMainTab("main")}
                >
                  {t("agent.swarmTabMain")}
                </button>
                <button
                  type="button"
                  className={`agentz-workz-swarm-tab${swarmMainTab === "chatroom" ? " active" : ""}`}
                  onClick={() => setSwarmMainTab("chatroom")}
                >
                  {t("agent.swarmTabChatroom")}
                </button>
                <button
                  type="button"
                  className={`agentz-workz-swarm-tab${swarmMainTab === "coordination" ? " active" : ""}`}
                  onClick={() => setSwarmMainTab("coordination")}
                >
                  {t("agent.swarmTabCoordination")}
                </button>
              </div>
            )}
            {isSwarmTeam && projectDir && swarmMainTab !== "main" ? (
              activePoolId ? (
                <PoolActivityFeed
                  projectDir={projectDir}
                  poolId={activePoolId}
                  filter={swarmMainTab === "chatroom" ? "chat" : "events"}
                />
              ) : (
                <div className="agentz-workz-feed-loading">{t("common.loading")}</div>
              )
            ) : (
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
            )}
          </div>
          {previewPath && projectDir && (
            <AgentFilePreview
              projectDir={projectDir}
              path={previewPath}
              workspaceDir={worktree?.worktree_path ?? null}
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
          <div className="agentz-workz-bar-left">
            <label
              className="agentz-workz-isolate-toggle"
              title={taskBound ? t("agent.modeLocked") : t("agent.isolateHint")}
            >
              <input
                type="checkbox"
                checked={isolate}
                disabled={busy || taskBound}
                onChange={(e) => setIsolate(e.target.checked)}
              />
              <span>{isolate ? t("agent.isolateOn") : t("agent.isolateOff")}</span>
            </label>

            {teams.length > 0 && (
              <div
                className={`agentz-workz-pill-menu${taskBound ? " is-locked" : ""}`}
                title={
                  taskBound
                    ? t("agent.modeLocked")
                    : activeTeam
                      ? selectedTeam?.mode === "workflow"
                        ? t("agent.teamHintWorkflow")
                        : t("agent.teamHintSwarm")
                      : t("agent.teamHint")
                }
              >
                <span className="agentz-workz-pill-label">{t("agent.team")}</span>
                <DropdownSelect
                  variant="pill"
                  placement="up"
                  value={activeTeam}
                  options={teamOptions}
                  disabled={busy || taskBound}
                  onChange={handleTeamChange}
                />
              </div>
            )}

            {!activeTeam && agents.length > 0 && (
              <div
                className={`agentz-workz-pill-menu${taskBound ? " is-locked" : ""}`}
                title={taskBound ? t("agent.modeLocked") : t("agent.agentHint")}
              >
                <span className="agentz-workz-pill-label">{t("agent.agentLabel")}</span>
                <DropdownSelect
                  variant="pill"
                  placement="up"
                  value={activeAgentId}
                  options={agentOptions}
                  disabled={busy || taskBound}
                  onChange={handleAgentChange}
                />
              </div>
            )}
          </div>

          <div className="agentz-workz-bar-right">
            {isSwarmTeam && activePoolId && (
              <button
                type="button"
                className="agentz-workz-review-btn"
                onClick={() => setBoardOpen(true)}
              >
                {t("collab.openBoard")}
              </button>
            )}
            {isWorkflowTeam && workflowRunId && (
              <button
                type="button"
                className="agentz-workz-review-btn"
                onClick={() => setWorkflowOpen(true)}
              >
                {t("workflow.designer")}
                {workflowStatus ? ` · ${t(`workflow.status.${workflowStatus}`)}` : ""}
              </button>
            )}
            {isWorkflowTeam && (
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
          onPaste={(e) => void handlePaste(e)}
          modelId={modelId}
          modelOptions={modelOptions}
          onModelChange={setModelId}
          showModelSelector={showModelSelector}
          modeNotice={composerModeNotice}
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
            refreshGitChanges();
            refreshTasks();
          }}
        />
      )}
    </div>
  );
}
