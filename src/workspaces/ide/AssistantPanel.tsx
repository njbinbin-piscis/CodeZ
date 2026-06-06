import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  chatSend,
  chatCancel,
  onChatEvent,
  listSessions,
  getMessages,
  forkSession,
  deleteSession,
  restoreCheckpoint,
  journalListChanges,
  journalUndoTurn,
  type AgentEvent,
  type ChatAttachment,
  type ChatEventEnvelope,
  type ChatMode,
  type JournalChange,
  type MessageDto,
  type PlanTodoItem,
  type SessionMeta,
} from "../../services/tauri/chat";
import { getSettings, type LlmProviderConfig, type SettingsResponse } from "../../services/tauri/settings";
import { listInstalledSkills, type InstalledSkill } from "../../services/tauri/workbench";
import { listAgents, type AgentInfo } from "../../services/tauri/agents";
import { ideApi } from "../../services/tauri/ide";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ChatComposer, { type ComposerMenuOption } from "../../components/ChatComposer";
import {
  composePromptWithChips,
  createBrowserElementChip,
  createFileRefChip,
  createImageAttachmentChip,
  createTerminalSnippetChip,
  extractImageAttachment,
  type ComposerChip,
} from "../../components/composerChips";
import type { PickedElement } from "../../services/tauri/browser";
import {
  absPathToProjectRel,
  blobToDataUrl,
  dataUrlToBase64,
  modelLabel,
  pickChatAttachment,
} from "../../components/chatComposerUtils";
import { visionCapable } from "../../components/visionUtils";
import ContextUsageRing, { type ContextUsageSnapshot } from "../../components/ContextUsageRing";
import { formatUserMessageDisplay } from "../../components/chatFileRefs";
import UserMessage from "../../components/UserMessage";
import TaskPanel, {
  mergePlanItems,
  parsePlanFromToolInput,
  type ToolStep,
} from "../../components/TaskPanel";
import type { FileNode } from "./types";
import Markdown from "./Markdown";
import InteractiveCard from "../../components/chat/InteractiveCard";
import { useInteractiveCards } from "../../hooks/useInteractiveCards";
import "./AssistantPanel.css";

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
}

function messageFromDto(m: MessageDto): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.role === "user" ? formatUserMessageDisplay(m.content) : m.content,
  };
}

interface AssistantPanelProps {
  projectDir: string | null;
  /** External request to insert @file references into the composer. */
  insertRequest?: { paths: string[]; nonce: number } | null;
  /** External request to add a picked browser element chip to the composer. */
  insertElementRequest?: { element: PickedElement; nonce: number } | null;
  /** External request to add a terminal selection chip to the composer. */
  insertTerminalRequest?: { snippetId: string; text: string; nonce: number } | null;
  /** External request to set an attachment (e.g. a browser screenshot). */
  attachRequest?: { attachment: ChatAttachment; preview: string | null; nonce: number } | null;
}

interface QueuedTurn {
  text: string;
  attachment: ChatAttachment | null;
  clearPlan: boolean;
}

interface PlanResumeState {
  text: string;
  attachment: ChatAttachment | null;
}

function revokeImageChipPreviews(chips: ComposerChip[]) {
  for (const chip of chips) {
    if (chip.kind === "image-attachment" && chip.preview.startsWith("blob:")) {
      URL.revokeObjectURL(chip.preview);
    }
  }
}

function flattenFiles(nodes: FileNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) {
      // Include the directory itself so `@folder` is selectable, then recurse.
      acc.push(n.path.endsWith("/") ? n.path : `${n.path}/`);
      if (n.children) flattenFiles(n.children, acc);
    } else {
      acc.push(n.path);
    }
  }
  return acc;
}

/** Special whole-repo mention surfaced at the top of the @ menu. */
const CODEBASE_MENTION = "codebase";

interface MentionState {
  query: string;
  start: number;
  caret: number;
  active: number;
}

export default function AssistantPanel({
  projectDir,
  insertRequest,
  insertElementRequest,
  insertTerminalRequest,
  attachRequest,
}: AssistantPanelProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedView, setQueuedView] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    const saved = localStorage.getItem("codez-chat-mode");
    return saved === "plan" ? "plan" : "agent";
  });
  const [modelId, setModelId] = useState(() => localStorage.getItem("codez-model-id") ?? "");
  const [llmProviders, setLlmProviders] = useState<LlmProviderConfig[]>([]);
  const [defaultModelLabel, setDefaultModelLabel] = useState("");
  const [appSettings, setAppSettings] = useState<SettingsResponse | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [planItems, setPlanItems] = useState<PlanTodoItem[]>([]);
  const [review, setReview] = useState<{ turnId: string; changes: JournalChange[] } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [taskPanelTab, setTaskPanelTab] = useState<"todo" | "tools">("todo");
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [planResume, setPlanResume] = useState<PlanResumeState | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [composerChips, setComposerChips] = useState<ComposerChip[]>([]);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [enabledSkills, setEnabledSkills] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("codez-enabled-skills");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>(
    () => localStorage.getItem("codez-active-agent") ?? "",
  );

  const {
    pendingCards,
    handleAgentEvent,
    markSubmitted,
    markActionSent,
    clearCards,
  } = useInteractiveCards();

  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const queueRef = useRef<QueuedTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const runTurnRef = useRef<(turn: QueuedTurn) => Promise<void>>(async () => {});

  useEffect(() => {
    sessionRef.current = null;
    queueRef.current = [];
    setQueuedView([]);
    setMessages([]);
    setSessions([]);
    setPlanItems([]);
    setToolSteps([]);
    setError(null);
    setShowSessions(false);
    setContextUsage(null);
    clearCards();
    setComposerChips((cur) => {
      revokeImageChipPreviews(cur);
      return [];
    });
  }, [projectDir, clearCards]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setAppSettings(s);
        setLlmProviders(s.llm_providers ?? []);
        const label = s.model?.trim() ? `${s.provider}/${s.model}` : s.provider || "default";
        setDefaultModelLabel(label);
      })
      .catch(() => {
        setAppSettings(null);
        setLlmProviders([]);
      });
  }, []);

  useEffect(() => {
    listInstalledSkills()
      .then((skills) => {
        setInstalledSkills(skills);
        const slugs = new Set(skills.map((s) => s.slug));
        setEnabledSkills((cur) => cur.filter((s) => slugs.has(s)));
      })
      .catch(() => setInstalledSkills([]));
    listAgents()
      .then((list) => {
        setAgents(list);
        const ids = new Set(list.map((a) => a.id));
        setActiveAgent((cur) => (cur && !ids.has(cur) ? "" : cur));
      })
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem("codez-chat-mode", chatMode);
  }, [chatMode]);

  useEffect(() => {
    localStorage.setItem("codez-model-id", modelId);
  }, [modelId]);

  useEffect(() => {
    localStorage.setItem("codez-enabled-skills", JSON.stringify(enabledSkills));
  }, [enabledSkills]);

  useEffect(() => {
    localStorage.setItem("codez-active-agent", activeAgent);
  }, [activeAgent]);

  useEffect(() => {
    if (!insertRequest?.paths.length) return;
    const newChips = insertRequest.paths.map((p) => {
      const isDir = /[/\\]$/.test(p);
      const rel = p.replace(/^[/\\]+/, "");
      const path = isDir ? `${rel.replace(/[/\\]+$/, "")}/` : rel;
      return createFileRefChip(path, isDir);
    });
    setComposerChips((cur) => [...cur, ...newChips]);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [insertRequest?.nonce, insertRequest?.paths]);

  useEffect(() => {
    if (!insertElementRequest?.element) return;
    setComposerChips((cur) => [...cur, createBrowserElementChip(insertElementRequest.element)]);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [insertElementRequest?.nonce, insertElementRequest?.element]);

  useEffect(() => {
    if (!insertTerminalRequest?.snippetId) return;
    const lineCount = insertTerminalRequest.text.split(/\r?\n/).length;
    const preview = insertTerminalRequest.text.replace(/\s+/g, " ").trim().slice(0, 80);
    setComposerChips((cur) => [
      ...cur,
      createTerminalSnippetChip(insertTerminalRequest.snippetId, preview, lineCount),
    ]);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [insertTerminalRequest?.nonce, insertTerminalRequest?.snippetId, insertTerminalRequest?.text]);

  useEffect(() => {
    if (!attachRequest?.attachment) return;
    if (attachRequest.attachment.media_type.startsWith("image/")) {
      if (!appSettings || !visionCapable(appSettings, modelId, llmProviders)) {
        setToast(t("chat.visionRequired"));
        return;
      }
    }
    const preview =
      attachRequest.preview ??
      (attachRequest.attachment.data
        ? `data:${attachRequest.attachment.media_type};base64,${attachRequest.attachment.data}`
        : "");
    if (!preview) return;
    setComposerChips((cur) => {
      revokeImageChipPreviews(cur.filter((c) => c.kind === "image-attachment"));
      return [
        ...cur.filter((c) => c.kind !== "image-attachment"),
        createImageAttachmentChip(attachRequest.attachment, preview),
      ];
    });
    requestAnimationFrame(() => taRef.current?.focus());
  }, [
    attachRequest?.nonce,
    attachRequest?.attachment,
    attachRequest?.preview,
    appSettings,
    modelId,
    llmProviders,
    t,
  ]);

  const addImageChip = useCallback((attachment: ChatAttachment, preview: string) => {
    setComposerChips((cur) => {
      revokeImageChipPreviews(cur.filter((c) => c.kind === "image-attachment"));
      return [
        ...cur.filter((c) => c.kind !== "image-attachment"),
        createImageAttachmentChip(attachment, preview),
      ];
    });
  }, []);

  useEffect(() => {
    if (!projectDir) {
      setFiles([]);
      return;
    }
    ideApi
      .listFiles(projectDir)
      .then((nodes) => setFiles(flattenFiles(nodes).sort()))
      .catch(() => setFiles([]));
  }, [projectDir]);

  const applyEvent = useCallback((env: ChatEventEnvelope) => {
    if (!busyRef.current) return;
    if (env.channel === "agent_final") {
      const fin = env.payload as { ok: boolean; error?: string };
      if (!fin.ok && fin.error) setError(fin.error);
      return;
    }
    if (env.channel !== "agent_event") return;
    const evt = env.payload as AgentEvent;

    switch (evt.type) {
      case "text_delta":
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last.role !== "assistant") return prev;
          copy[copy.length - 1] = { ...last, text: last.text + evt.delta };
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
        break;
      case "tool_end": {
        setToolSteps((prev) =>
          prev.map((step) =>
            step.id === evt.id
              ? {
                  ...step,
                  completed: true,
                  result: evt.result,
                  isError: evt.is_error,
                }
              : step,
          ),
        );
        break;
      }
      case "plan_update":
        setPlanItems(evt.items);
        setTaskPanelOpen(true);
        setTaskPanelTab("todo");
        break;
      case "context_usage":
        setContextUsage({
          estimatedInputTokens: evt.estimated_input_tokens,
          totalInputBudget: evt.total_input_budget,
          triggerThreshold: evt.trigger_threshold,
          cumulativeInputTokens: evt.cumulative_input_tokens,
          cumulativeOutputTokens: evt.cumulative_output_tokens,
          rollingSummaryVersion: evt.rolling_summary_version,
          autoCompactThreshold: evt.auto_compact_threshold,
        });
        break;
      case "error":
        setError(evt.message);
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

  const applyDroppedPaths = useCallback(
    (paths: string[]) => {
      if (!projectDir) return;
      const chips = paths.map((abs) =>
        createFileRefChip(absPathToProjectRel(abs, projectDir), false),
      );
      setComposerChips((cur) => [...cur, ...chips]);
      taRef.current?.focus();
    },
    [projectDir],
  );

  // OS file drag-and-drop → file-ref chips. Tauri captures native file drops at the
  // webview level (HTML5 ondrop never fires for files), so we subscribe to the
  // webview drag-drop stream and only react when the pointer is over this panel.
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
          if (over && p.paths.length > 0) {
            applyDroppedPaths(p.paths);
          }
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, queuedView]);

  runTurnRef.current = async (turn: QueuedTurn) => {
    setError(null);
    const displayText =
      turn.attachment && !turn.text.trim()
        ? `📎 ${turn.attachment.filename ?? turn.attachment.path ?? t("chat.attachment")}`
        : turn.attachment
          ? `${turn.text}${turn.text.trim() ? "\n" : ""}📎 ${turn.attachment.filename ?? turn.attachment.path ?? t("chat.attachment")}`
          : turn.text;
    setMessages((m) => [...m, { role: "user", text: displayText }, { role: "assistant", text: "" }]);
    setToolSteps([]);
    if (turn.clearPlan) setPlanItems([]);
    setBusy(true);
    try {
      const res = await chatSend({
        prompt: turn.text,
        displayPrompt: displayText,
        sessionId: sessionRef.current,
        projectDir: projectDir!,
        attachment: turn.attachment,
        chatMode,
        modelId: modelId || null,
        clearPlan: turn.clearPlan,
        enabledSkills: enabledSkills.length > 0 ? enabledSkills : null,
        agentId: activeAgent || null,
      });
      sessionRef.current = res.session_id;
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && !last.text.trim()) {
          copy[copy.length - 1] = { ...last, text: res.response_text };
        }
        return copy;
      });
      // Surface this turn's file edits in the Review bar (Undo All / Keep).
      if (res.turn_id && projectDir) {
        try {
          const changes = await journalListChanges(projectDir, res.session_id, res.turn_id);
          setReview(changes.length > 0 ? { turnId: res.turn_id, changes } : null);
        } catch {
          // journal is best-effort; ignore listing failures
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (sessionRef.current && queueRef.current.length === 0) {
        try {
          await syncMessagesFromDb(sessionRef.current);
        } catch {
          // keep in-memory messages if reload fails
        }
      }
      const next = queueRef.current.shift();
      if (next) {
        setQueuedView(queueRef.current.map((q) => q.text));
        void runTurnRef.current(next);
      }
    }
  };

  const doSend = useCallback(
    (text: string, att: ChatAttachment | null, clearPlan: boolean) => {
      if (busy) {
        queueRef.current.push({ text, attachment: att, clearPlan });
        setQueuedView(queueRef.current.map((q) => q.text));
      } else {
        void runTurnRef.current({ text, attachment: att, clearPlan });
      }
    },
    [busy],
  );

  const undoTurn = useCallback(async () => {
    if (!review || !projectDir || !sessionRef.current) return;
    setUndoing(true);
    try {
      await journalUndoTurn(projectDir, sessionRef.current, review.turnId);
      // The file watcher reloads affected tabs and refreshes git status.
      setReview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setUndoing(false);
    }
  }, [review, projectDir]);

  const submit = useCallback(() => {
    const text = composePromptWithChips(composerChips, input);
    const pendingAttachment = extractImageAttachment(composerChips);
    if (!text && !pendingAttachment) return;
    if (!projectDir) {
      setError(t("chat.noProject"));
      return;
    }
    setInput("");
    setComposerChips((cur) => {
      revokeImageChipPreviews(cur);
      return [];
    });
    setMention(null);

    const unfinished = planItems.filter((i) => i.status === "pending" || i.status === "in_progress");
    if (unfinished.length > 0) {
      setPlanResume({ text, attachment: pendingAttachment });
      return;
    }
    doSend(text, pendingAttachment, true);
  }, [input, composerChips, projectDir, planItems, doSend, t]);

  const onModeChange = (mode: ChatMode) => {
    setChatMode(mode);
    setModeNotice(mode === "plan" ? t("chat.modePlanHint") : t("chat.modeAgentHint"));
    window.setTimeout(() => setModeNotice(null), 4000);
  };

  const refreshSessions = useCallback(() => {
    if (!projectDir) {
      setSessions([]);
      return;
    }
    listSessions(projectDir).then(setSessions).catch(() => setSessions([]));
  }, [projectDir]);

  const syncMessagesFromDb = useCallback(
    async (sessionId: string) => {
      if (!projectDir) return;
      const history = await getMessages(sessionId, projectDir);
      setMessages(history.map(messageFromDto));
    },
    [projectDir],
  );

  useEffect(() => {
    if (showSessions) refreshSessions();
  }, [showSessions, refreshSessions]);

  const newSession = useCallback(() => {
    sessionRef.current = null;
    queueRef.current = [];
    setQueuedView([]);
    setMessages([]);
    setPlanItems([]);
    setToolSteps([]);
    setError(null);
    setShowSessions(false);
    setContextUsage(null);
  }, []);

  const switchSession = useCallback(
    async (id: string) => {
      try {
        sessionRef.current = id;
        await syncMessagesFromDb(id);
        setPlanItems([]);
        setToolSteps([]);
        setError(null);
        setShowSessions(false);
        setContextUsage(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [syncMessagesFromDb],
  );

  const forkFromCheckpoint = useCallback(
    async (messageId: string) => {
      if (!sessionRef.current || !projectDir || busy) return;
      try {
        const forked = await forkSession(sessionRef.current, projectDir!, undefined, messageId);
        refreshSessions();
        await switchSession(forked.id);
      } catch (e) {
        setError(String(e));
      }
    },
    [busy, projectDir, refreshSessions, switchSession],
  );

  const restoreToCheckpoint = useCallback(
    async (messageId: string) => {
      if (!sessionRef.current || !projectDir || busy) return;
      if (!window.confirm(t("chat.checkpointRestoreConfirm"))) return;
      // Offer to also roll back the file edits the agent applied afterwards.
      // The file watcher reloads affected tabs + refreshes git status.
      const restoreFiles = window.confirm(t("chat.checkpointRestoreFiles"));
      try {
        await restoreCheckpoint(
          sessionRef.current,
          messageId,
          projectDir!,
          restoreFiles,
        );
        await syncMessagesFromDb(sessionRef.current);
        setPlanItems([]);
        setToolSteps([]);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [busy, projectDir, syncMessagesFromDb, t],
  );

  const fork = useCallback(async () => {
    if (!sessionRef.current || !projectDir) return;
    try {
      const forked = await forkSession(sessionRef.current, projectDir!);
      refreshSessions();
      await switchSession(forked.id);
    } catch (e) {
      setError(String(e));
    }
  }, [projectDir, refreshSessions, switchSession]);

  const removeSession = useCallback(
    async (id: string) => {
      if (!projectDir) return;
      try {
        await deleteSession(id, projectDir!);
        if (sessionRef.current === id) newSession();
        refreshSessions();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectDir, newSession, refreshSessions],
  );

  const handleAttach = useCallback(async () => {
    if (!projectDir) return;
    try {
      const picked = await pickChatAttachment();
      if (!picked) return;
      if (picked.attachment.media_type.startsWith("image/")) {
        if (!appSettings || !visionCapable(appSettings, modelId, llmProviders)) {
          setToast(t("chat.visionRequired"));
          return;
        }
        const preview =
          picked.preview ??
          (picked.attachment.data
            ? `data:${picked.attachment.media_type};base64,${picked.attachment.data}`
            : "");
        if (!preview) return;
        addImageChip(picked.attachment, preview);
      } else if (picked.attachment.path) {
        const rel = absPathToProjectRel(picked.attachment.path, projectDir);
        setComposerChips((cur) => [...cur, createFileRefChip(rel, false)]);
      }
      taRef.current?.focus();
    } catch (e) {
      setError(String(e));
    }
  }, [projectDir, appSettings, modelId, llmProviders, addImageChip, t]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault();
        if (!appSettings || !visionCapable(appSettings, modelId, llmProviders)) {
          setToast(t("chat.visionRequired"));
          return;
        }
        const file = item.getAsFile();
        if (!file) return;
        try {
          const dataUrl = await blobToDataUrl(file);
          const data = dataUrlToBase64(dataUrl);
          addImageChip(
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
    [appSettings, modelId, llmProviders, addImageChip, t],
  );

  const modelOptions = useMemo(() => {
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

  const modeOptions = useMemo(
    (): ComposerMenuOption[] => [
      { id: "agent", label: t("chat.modeAgent"), hint: t("chat.modeAgentHint") },
      { id: "plan", label: t("chat.modePlan"), hint: t("chat.modePlanHint") },
    ],
    [t],
  );

  const canSend = Boolean(projectDir && (input.trim() || composerChips.length > 0));

  const unfinishedCount = planItems.filter((i) => i.status === "pending" || i.status === "in_progress").length;

  const onInputChange = (value: string, caret?: number) => {
    setInput(value);
    const pos = caret ?? value.length;
    const before = value.slice(0, pos);
    const m = before.match(/(?:^|\s)@([^\s]*)$/);
    if (m) setMention({ query: m[1], start: pos - m[1].length - 1, caret: pos, active: 0 });
    else setMention(null);
  };

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const out: string[] = [];
    // Surface the whole-repo `@codebase` recall mention first.
    if (CODEBASE_MENTION.startsWith(q)) out.push(CODEBASE_MENTION);
    for (const f of files) {
      if (out.length >= 9) break;
      if (f.toLowerCase().includes(q)) out.push(f);
    }
    return out;
  }, [mention, files]);

  const pickMention = useCallback(
    (path: string) => {
      if (!mention) return;
      setInput((cur) => {
        const next = cur.slice(0, mention.start) + "@" + path + " " + cur.slice(mention.caret);
        const pos = mention.start + path.length + 2;
        requestAnimationFrame(() => {
          taRef.current?.focus();
          taRef.current?.setSelectionRange(pos, pos);
        });
        return next;
      });
      setMention(null);
    },
    [mention],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % matches.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active - 1 + matches.length) % matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(matches[mention.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const toggleToolStep = (id: string) => {
    setToolSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, expanded: !step.expanded } : step)),
    );
  };

  const inputPlaceholder = !projectDir
    ? t("chat.noProject")
    : busy
      ? t("chat.placeholderBusyQueue")
      : chatMode === "plan"
        ? t("chat.placeholderPlan")
        : t("chat.placeholderFollowUp");

  return (
    <div className="codez-assistant" ref={panelRef}>
      <div className="codez-assistant-header">
        <span>{t("chat.title")}</span>
        <div className="codez-assistant-actions">
          <ContextUsageRing usage={contextUsage} />
          <button className={showSessions ? "active" : ""} onClick={() => setShowSessions((v) => !v)} title={t("chat.sessions")}>
            ☰
          </button>
          <button onClick={newSession} title={t("chat.newChat")}>＋</button>
          <button onClick={() => void fork()} disabled={!sessionRef.current} title={t("chat.fork")}>⑂</button>
        </div>
      </div>

      {toast && <div className="codez-assistant-toast">{toast}</div>}

      {dragOver && (
        <div className="codez-assistant-dropzone">
          <span>{t("chat.dropToAddRefs")}</span>
        </div>
      )}

      {showSessions && (
        <div className="codez-session-list">
          {sessions.length === 0 && <div className="codez-session-empty">{t("chat.noSessions")}</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`codez-session-row ${s.id === sessionRef.current ? "active" : ""}`}
              onClick={() => void switchSession(s.id)}
            >
              <span className="codez-session-title">{s.title || t("chat.untitled")}</span>
              <span className="codez-session-count">{s.message_count}</span>
              <button
                className="codez-session-del"
                title={t("chat.delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <TaskPanel
        planItems={planItems}
        toolSteps={toolSteps}
        busy={busy}
        open={taskPanelOpen}
        onOpenChange={setTaskPanelOpen}
        tab={taskPanelTab}
        onTabChange={setTaskPanelTab}
        onToggleToolStep={toggleToolStep}
      />

      <div className="codez-assistant-messages" ref={scrollRef}>
        {messages.length === 0 && <div className="codez-assistant-empty">{t("chat.empty")}</div>}
        {messages.map((m, i) => {
          const isStreamingLast = m.role === "assistant" && busy && i === messages.length - 1;
          const showCheckpoint =
            m.role === "assistant" && m.id && m.text.trim() && !isStreamingLast;
          return (
            <div key={m.id ?? `msg-${i}`} className={`codez-msg ${m.role}`}>
              <div className="codez-msg-role">{m.role === "user" ? t("chat.you") : t("chat.agentRole")}</div>
              {m.text ? (
                m.role === "assistant" ? (
                  <Markdown content={m.text} enableApply />
                ) : (
                  <UserMessage text={m.text} />
                )
              ) : isStreamingLast ? (
                <div className="codez-msg-text codez-thinking">{t("chat.thinking")}</div>
              ) : null}
              {showCheckpoint && (
                <div className="codez-checkpoint">
                  <span className="codez-checkpoint-label">{t("chat.checkpoint")}</span>
                  <button
                    type="button"
                    className="codez-checkpoint-btn"
                    onClick={() => void forkFromCheckpoint(m.id!)}
                    title={t("chat.checkpointFork")}
                  >
                    {t("chat.checkpointFork")}
                  </button>
                  <button
                    type="button"
                    className="codez-checkpoint-btn muted"
                    onClick={() => void restoreToCheckpoint(m.id!)}
                    title={t("chat.checkpointRestore")}
                  >
                    {t("chat.checkpointRestore")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {queuedView.map((q, i) => (
          <div key={`q-${i}`} className="codez-msg user queued">
            <div className="codez-msg-role">{t("chat.queued")}</div>
            <div className="codez-msg-text">{q}</div>
          </div>
        ))}
        {pendingCards.map((card) => (
          <div key={card.requestId} className="codez-msg assistant">
            <div className="codez-msg-role">{t("chat.agentRole")}</div>
            <InteractiveCard
              requestId={card.requestId}
              uiDefinition={card.uiDefinition}
              listenOpen={card.listenOpen}
              wizardStepHint={card.wizardStepHint}
              onSubmitted={() => markSubmitted(card.requestId)}
              onActionSent={() => markActionSent(card.requestId)}
            />
          </div>
        ))}
      </div>

      {error && <div className="codez-assistant-error">{error}</div>}

      {review && (
        <div className="codez-review-bar">
          <div className="codez-review-head">
            <span className="codez-review-title">
              {t("chat.reviewChanges", { count: review.changes.length })}
            </span>
            <div className="codez-review-actions">
              <button
                type="button"
                className="codez-review-btn danger"
                disabled={undoing}
                onClick={() => void undoTurn()}
                title={t("chat.undoAll")}
              >
                {undoing ? t("chat.undoing") : t("chat.undoAll")}
              </button>
              <button
                type="button"
                className="codez-review-btn"
                disabled={undoing}
                onClick={() => setReview(null)}
                title={t("chat.keepAll")}
              >
                {t("chat.keepAll")}
              </button>
            </div>
          </div>
          <ul className="codez-review-files">
            {review.changes.map((c) => (
              <li key={c.id} className="codez-review-file" title={c.rel_path}>
                <span className={`codez-review-tag ${c.existed ? "edit" : "new"}`}>
                  {c.existed ? "M" : "A"}
                </span>
                <span className="codez-review-path">{c.rel_path}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ChatComposer
        value={input}
        onChange={onInputChange}
        onSubmit={submit}
        onStop={() => void chatCancel()}
        busy={busy}
        placeholder={inputPlaceholder}
        canSend={canSend}
        inputDisabled={!projectDir}
        chips={composerChips}
        onRemoveChip={(id) =>
          setComposerChips((cur) => {
            const removed = cur.find((c) => c.id === id);
            if (removed?.kind === "image-attachment" && removed.preview.startsWith("blob:")) {
              URL.revokeObjectURL(removed.preview);
            }
            return cur.filter((c) => c.id !== id);
          })
        }
        textareaRef={taRef}
        onKeyDown={onKeyDown}
        onPaste={(e) => void handlePaste(e)}
        modelId={modelId}
        modelOptions={modelOptions}
        onModelChange={setModelId}
        attachment={null}
        attachmentPreview={null}
        onAttach={() => void handleAttach()}
        onClearAttachment={() => {}}
        attachTitle={t("chat.attachFile")}
        removeAttachmentTitle={t("chat.removeAttachment")}
        stopTitle={t("chat.stop")}
        sendTitle={t("chat.send")}
        modeSelector={{
          chatMode,
          options: modeOptions,
          onChange: onModeChange,
        }}
        skillSelector={{
          label: t("chat.skills"),
          emptyHint: t("chat.skillsEmpty"),
          selected: enabledSkills,
          onChange: setEnabledSkills,
          options: installedSkills.map((s) => ({
            id: s.slug,
            label: s.name,
            hint: s.description,
          })),
        }}
        agentSelector={{
          value: activeAgent,
          onChange: setActiveAgent,
          options: [
            { id: "", label: t("chat.agentDefault") },
            ...agents.map((a) => ({
              id: a.id,
              label: a.icon ? `${a.icon} ${a.name}` : a.name,
              hint: a.description || a.role,
            })),
          ],
        }}
        modeNotice={modeNotice}
        mentionPopup={
          mention && matches.length > 0 ? (
            <div className="codez-mention-popup">
              {matches.map((f, i) => (
                <div
                  key={f}
                  className={`codez-mention-item ${i === mention.active ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(f);
                  }}
                >
                  {f === CODEBASE_MENTION ? `codebase · ${t("chat.mentionCodebase")}` : f}
                </div>
              ))}
            </div>
          ) : null
        }
      />

      {planResume && (
        <div className="codez-plan-resume-overlay" onClick={() => setPlanResume(null)}>
          <div className="codez-plan-resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chat.planResumeTitle")}</h3>
            <p>{t("chat.planResumeMessage", { count: unfinishedCount })}</p>
            <div className="codez-plan-resume-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const pending = planResume;
                  setPlanResume(null);
                  doSend(pending.text, pending.attachment, false);
                }}
              >
                {t("chat.planResumeContinue")}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const pending = planResume;
                  setPlanResume(null);
                  doSend(pending.text, pending.attachment, true);
                }}
              >
                {t("chat.planResumeClear")}
              </button>
              <button type="button" className="muted" onClick={() => setPlanResume(null)}>
                {t("chat.planResumeCancelSend")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
