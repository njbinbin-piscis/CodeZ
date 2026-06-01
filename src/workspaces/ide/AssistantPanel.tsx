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
import { getSettings, type LlmProviderConfig } from "../../services/tauri/settings";
import { ideApi } from "../../services/tauri/ide";
import ChatComposer, { type ComposerMenuOption } from "../../components/ChatComposer";
import { modelLabel, pickChatAttachment } from "../../components/chatComposerUtils";
import { formatUserMessageDisplay } from "../../components/chatFileRefs";
import UserMessage from "../../components/UserMessage";
import TaskPanel, {
  mergePlanItems,
  parsePlanFromToolInput,
  type ToolStep,
} from "../../components/TaskPanel";
import type { FileNode } from "./types";
import Markdown from "./Markdown";
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
  onClose: () => void;
  /** External request to insert @file references into the composer. */
  insertRequest?: { paths: string[]; nonce: number } | null;
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

function flattenFiles(nodes: FileNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) {
      if (n.children) flattenFiles(n.children, acc);
    } else {
      acc.push(n.path);
    }
  }
  return acc;
}

interface MentionState {
  query: string;
  start: number;
  caret: number;
  active: number;
}

export default function AssistantPanel({ projectDir, onClose, insertRequest }: AssistantPanelProps) {
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
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [planItems, setPlanItems] = useState<PlanTodoItem[]>([]);
  const [review, setReview] = useState<{ turnId: string; changes: JournalChange[] } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [taskPanelTab, setTaskPanelTab] = useState<"todo" | "tools">("todo");
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [planResume, setPlanResume] = useState<PlanResumeState | null>(null);

  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const queueRef = useRef<QueuedTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
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
  }, [projectDir]);

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
    localStorage.setItem("codez-chat-mode", chatMode);
  }, [chatMode]);

  useEffect(() => {
    localStorage.setItem("codez-model-id", modelId);
  }, [modelId]);

  useEffect(() => {
    if (!insertRequest?.paths.length) return;
    const refs = insertRequest.paths
      .map((p) => `@${p.replace(/^[/\\]+/, "")}`)
      .join(" ");
    setInput((cur) => {
      const prefix = cur.trim() ? `${cur.trimEnd()} ` : "";
      return `${prefix}${refs} `;
    });
    requestAnimationFrame(() => {
      taRef.current?.focus();
      const len = taRef.current?.value.length ?? 0;
      taRef.current?.setSelectionRange(len, len);
    });
  }, [insertRequest?.nonce, insertRequest?.paths]);

  const clearAttachment = useCallback(() => {
    setAttachment(null);
    if (attachmentPreview?.startsWith("blob:")) URL.revokeObjectURL(attachmentPreview);
    setAttachmentPreview(null);
  }, [attachmentPreview]);

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
      case "error":
        setError(evt.message);
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onChatEvent(applyEvent).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [applyEvent]);

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
    const text = input.trim();
    if (!text && !attachment) return;
    if (!projectDir) {
      setError(t("chat.noProject"));
      return;
    }
    const pendingAttachment = attachment;
    setInput("");
    setMention(null);
    clearAttachment();

    const unfinished = planItems.filter((i) => i.status === "pending" || i.status === "in_progress");
    if (unfinished.length > 0) {
      setPlanResume({ text, attachment: pendingAttachment });
      return;
    }
    doSend(text, pendingAttachment, true);
  }, [input, attachment, projectDir, planItems, clearAttachment, doSend, t]);

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
      try {
        await restoreCheckpoint(sessionRef.current, messageId, projectDir!);
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

  const canSend = Boolean(projectDir && (input.trim() || attachment));

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
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
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
    <div className="codez-assistant">
      <div className="codez-assistant-header">
        <span>{t("chat.title")}</span>
        <div className="codez-assistant-actions">
          <button className={showSessions ? "active" : ""} onClick={() => setShowSessions((v) => !v)} title={t("chat.sessions")}>
            ☰
          </button>
          <button onClick={newSession} title={t("chat.newChat")}>＋</button>
          <button onClick={() => void fork()} disabled={!sessionRef.current} title={t("chat.fork")}>⑂</button>
          <button className="codez-assistant-close" onClick={onClose} title={t("chat.hide")}>✕</button>
        </div>
      </div>

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
                  <Markdown content={m.text} />
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
        stopTitle={t("chat.stop")}
        sendTitle={t("chat.send")}
        modeSelector={{
          chatMode,
          options: modeOptions,
          onChange: onModeChange,
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
                  {f}
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
