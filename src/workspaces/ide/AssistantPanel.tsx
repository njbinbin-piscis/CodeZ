import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatSend,
  chatCancel,
  onChatEvent,
  listSessions,
  getMessages,
  forkSession,
  deleteSession,
  type AgentEvent,
  type ChatEventEnvelope,
  type SessionMeta,
} from "../../services/tauri/chat";
import { ideApi } from "../../services/tauri/ide";
import type { FileNode } from "./types";
import Markdown from "./Markdown";
import "./AssistantPanel.css";

interface ToolEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  result?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolEvent[];
}

interface AssistantPanelProps {
  projectDir: string | null;
  onClose: () => void;
}

/** Flatten the file tree to relative file paths (files only) for @-mentions. */
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

/** Resolve `@path` tokens to fenced file context prepended to the prompt. */
async function buildPrompt(raw: string, projectDir: string | null): Promise<string> {
  if (!projectDir) return raw;
  const refs = Array.from(raw.matchAll(/(?:^|\s)@([^\s]+)/g)).map((m) => m[1]);
  if (refs.length === 0) return raw;
  const blocks: string[] = [];
  for (const ref of refs) {
    try {
      const full = `${projectDir.replace(/[/\\]+$/, "")}/${ref.replace(/^[/\\]+/, "")}`;
      const file = await ideApi.readFile(full);
      if (!file.is_binary) {
        blocks.push(`\`\`\`${file.language || ""} ${ref}\n${file.content}\n\`\`\``);
      }
    } catch {
      // Unresolvable @ref — leave it as plain text in the prompt.
    }
  }
  if (blocks.length === 0) return raw;
  return `Context from referenced files:\n\n${blocks.join("\n\n")}\n\n---\n\n${raw}`;
}

interface MentionState {
  query: string;
  start: number;
  caret: number;
  active: number;
}

export default function AssistantPanel({ projectDir, onClose }: AssistantPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedView, setQueuedView] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const queueRef = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const runTurnRef = useRef<(text: string) => Promise<void>>(async () => {});

  // Load the file list for @-mentions whenever the project changes.
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

  // Update the in-flight (last) assistant message as kernel events stream in.
  const applyEvent = useCallback((env: ChatEventEnvelope) => {
    if (env.channel === "agent_final") {
      const fin = env.payload as { ok: boolean; error?: string };
      if (!fin.ok && fin.error) setError(fin.error);
      return;
    }
    if (env.channel !== "agent_event") return;
    const evt = env.payload as AgentEvent;

    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = prev.slice();
      const last = { ...copy[copy.length - 1] };
      if (last.role !== "assistant") return prev;
      last.tools = last.tools.slice();

      switch (evt.type) {
        case "text_delta":
          last.text += evt.delta;
          break;
        case "tool_start":
          last.tools.push({ id: evt.id, name: evt.name, status: "running" });
          break;
        case "tool_end": {
          const i = last.tools.findIndex((t) => t.id === evt.id);
          const upd: ToolEvent = {
            id: evt.id,
            name: evt.name,
            status: evt.is_error ? "error" : "done",
            result: evt.result,
          };
          if (i >= 0) last.tools[i] = upd;
          else last.tools.push(upd);
          break;
        }
        case "error":
          last.text += `\n\n⚠️ ${evt.message}`;
          break;
        default:
          break;
      }
      copy[copy.length - 1] = last;
      return copy;
    });
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

  // Reassigned every render so the recursive queue drain always sees fresh
  // projectDir / session state.
  runTurnRef.current = async (text: string) => {
    setError(null);
    setMessages((m) => [
      ...m,
      { role: "user", text, tools: [] },
      { role: "assistant", text: "", tools: [] },
    ]);
    setBusy(true);
    try {
      const prompt = await buildPrompt(text, projectDir);
      const res = await chatSend({ prompt, sessionId: sessionRef.current, workspace: projectDir });
      sessionRef.current = res.session_id;
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && !last.text.trim()) {
          copy[copy.length - 1] = { ...last, text: res.response_text };
        }
        return copy;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      const next = queueRef.current.shift();
      if (next !== undefined) {
        setQueuedView([...queueRef.current]);
        void runTurnRef.current(next);
      }
    }
  };

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (!projectDir) {
      setError("Open a project folder before chatting.");
      return;
    }
    setInput("");
    setMention(null);
    if (busy) {
      queueRef.current.push(text);
      setQueuedView([...queueRef.current]);
    } else {
      void runTurnRef.current(text);
    }
  }, [input, busy, projectDir]);

  // ── Session management ─────────────────────────────────────────────────
  const refreshSessions = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (showSessions) refreshSessions();
  }, [showSessions, refreshSessions]);

  const newSession = useCallback(() => {
    sessionRef.current = null;
    queueRef.current = [];
    setQueuedView([]);
    setMessages([]);
    setError(null);
    setShowSessions(false);
  }, []);

  const switchSession = useCallback(async (id: string) => {
    try {
      const history = await getMessages(id);
      sessionRef.current = id;
      setMessages(history.map((m) => ({ role: m.role, text: m.content, tools: [] })));
      setError(null);
      setShowSessions(false);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const fork = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      const forked = await forkSession(sessionRef.current);
      refreshSessions();
      await switchSession(forked.id);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshSessions, switchSession]);

  const removeSession = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        if (sessionRef.current === id) newSession();
        refreshSessions();
      } catch (e) {
        setError(String(e));
      }
    },
    [newSession, refreshSessions],
  );

  // ── @-mention detection on every input change ──────────────────────────
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const caret = e.target.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s]*)$/);
    if (m) {
      setMention({ query: m[1], start: caret - m[1].length - 1, caret, active: 0 });
    } else {
      setMention(null);
    }
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="codez-assistant">
      <div className="codez-assistant-header">
        <span>AI Chat</span>
        <div className="codez-assistant-actions">
          <button
            className={showSessions ? "active" : ""}
            onClick={() => setShowSessions((v) => !v)}
            title="Sessions"
          >
            ☰
          </button>
          <button onClick={newSession} title="New chat">
            ＋
          </button>
          <button onClick={() => void fork()} disabled={!sessionRef.current} title="Fork this chat">
            ⑂
          </button>
          <button className="codez-assistant-close" onClick={onClose} title="Hide chat">
            ✕
          </button>
        </div>
      </div>

      {showSessions && (
        <div className="codez-session-list">
          {sessions.length === 0 && <div className="codez-session-empty">No sessions yet.</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`codez-session-row ${s.id === sessionRef.current ? "active" : ""}`}
              onClick={() => void switchSession(s.id)}
            >
              <span className="codez-session-title">{s.title || "Untitled"}</span>
              <span className="codez-session-count">{s.message_count}</span>
              <button
                className="codez-session-del"
                title="Delete"
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

      <div className="codez-assistant-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="codez-assistant-empty">
            Ask about the codebase or request a change. Reference files with{" "}
            <code>@path/to/file</code>. The agent edits files in place; the editor reloads
            automatically.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`codez-msg ${m.role}`}>
            <div className="codez-msg-role">{m.role === "user" ? "You" : "Agent"}</div>
            {m.tools.length > 0 && (
              <div className="codez-msg-tools">
                {m.tools.map((t) => (
                  <span key={t.id} className={`codez-tool ${t.status}`} title={t.result || ""}>
                    {t.status === "running" ? "▶" : t.status === "error" ? "✗" : "✓"} {t.name}
                  </span>
                ))}
              </div>
            )}
            {m.text &&
              (m.role === "assistant" ? (
                <Markdown content={m.text} />
              ) : (
                <div className="codez-msg-text">{m.text}</div>
              ))}
            {m.role === "assistant" && !m.text && busy && i === messages.length - 1 && (
              <div className="codez-msg-text codez-thinking">Thinking…</div>
            )}
          </div>
        ))}
        {queuedView.map((q, i) => (
          <div key={`q-${i}`} className="codez-msg user queued">
            <div className="codez-msg-role">Queued</div>
            <div className="codez-msg-text">{q}</div>
          </div>
        ))}
      </div>

      {error && <div className="codez-assistant-error">{error}</div>}

      <div className="codez-assistant-input">
        {mention && matches.length > 0 && (
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
        )}
        <textarea
          ref={taRef}
          value={input}
          placeholder={busy ? "Agent is working — messages queue…" : "Message the agent  (Cmd/Ctrl+Enter, @ to reference files)"}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={3}
        />
        {busy && (
          <button className="codez-stop" onClick={() => void chatCancel()} title="Stop the agent">
            Stop
          </button>
        )}
        <button onClick={submit} disabled={!input.trim()}>
          {busy ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
