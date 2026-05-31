import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatSend,
  chatCancel,
  onChatEvent,
  listSessions,
  getMessages,
  deleteSession,
  type AgentEvent,
  type ChatEventEnvelope,
  type SessionMeta,
} from "../../services/tauri/chat";
import { ideApi } from "../../services/tauri/ide";
import type { GitFileStatus } from "../ide/types";
import Markdown from "../ide/Markdown";
import "./Agent.css";

interface ToolEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  result?: string;
}

interface Step {
  role: "user" | "assistant";
  text: string;
  tools: ToolEvent[];
}

interface AgentWorkspaceProps {
  projectDir: string | null;
}

/**
 * Agent mode (≈ Codex) — task-centric autonomous coding.
 *
 * Each task is a kernel session: submit a goal, the agent plans → edits → runs
 * tools in the open project, streaming its steps. The board lists past tasks
 * and a Changes panel surfaces the resulting `git status` for review.
 */
export default function AgentWorkspace({ projectDir }: AgentWorkspaceProps) {
  const [tasks, setTasks] = useState<SessionMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [changes, setChanges] = useState<GitFileStatus[]>([]);

  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<(goal: string) => Promise<void>>(async () => {});

  const refreshTasks = useCallback(() => {
    listSessions()
      .then(setTasks)
      .catch(() => setTasks([]));
  }, []);

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

  // Stream kernel events into the in-flight step (guarded: the event channel is
  // shared with the IDE chat panel, so only consume while we're running).
  const applyEvent = useCallback((env: ChatEventEnvelope) => {
    if (!busyRef.current) return;
    if (env.channel === "agent_final") {
      const fin = env.payload as { ok: boolean; error?: string };
      if (!fin.ok && fin.error) setError(fin.error);
      return;
    }
    if (env.channel !== "agent_event") return;
    const evt = env.payload as AgentEvent;
    setSteps((prev) => {
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
  }, [steps]);

  runRef.current = async (text: string) => {
    setError(null);
    setSteps((s) => [
      ...s,
      { role: "user", text, tools: [] },
      { role: "assistant", text: "", tools: [] },
    ]);
    setBusy(true);
    try {
      const res = await chatSend({ prompt: text, sessionId: sessionRef.current, workspace: projectDir });
      sessionRef.current = res.session_id;
      setSelectedId(res.session_id);
      setSteps((s) => {
        const copy = s.slice();
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
      refreshTasks();
      refreshChanges();
    }
  };

  const run = useCallback(() => {
    const text = goal.trim();
    if (!text || busy) return;
    if (!projectDir) {
      setError("Open a project folder before running a task.");
      return;
    }
    setGoal("");
    void runRef.current(text);
  }, [goal, busy, projectDir]);

  const newTask = useCallback(() => {
    if (busy) return;
    sessionRef.current = null;
    setSelectedId(null);
    setSteps([]);
    setError(null);
    setGoal("");
    requestAnimationFrame(() => taRef.current?.focus());
  }, [busy]);

  const openTask = useCallback(
    async (id: string) => {
      if (busy) return;
      try {
        const history = await getMessages(id);
        sessionRef.current = id;
        setSelectedId(id);
        setSteps(history.map((m) => ({ role: m.role, text: m.content, tools: [] })));
        setError(null);
        refreshChanges();
      } catch (e) {
        setError(String(e));
      }
    },
    [busy, refreshChanges],
  );

  const removeTask = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        if (sessionRef.current === id) newTask();
        refreshTasks();
      } catch (e) {
        setError(String(e));
      }
    },
    [newTask, refreshTasks],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  };

  return (
    <div className="codez-agent">
      <aside className="codez-agent-sidebar">
        <div className="codez-agent-sidebar-head">
          <span>Tasks</span>
          <button onClick={newTask} disabled={busy} title="New task">
            ＋ New
          </button>
        </div>
        <div className="codez-agent-tasklist">
          {tasks.length === 0 && <div className="codez-agent-tasks-empty">No tasks yet.</div>}
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`codez-agent-task ${t.id === selectedId ? "active" : ""}`}
              onClick={() => void openTask(t.id)}
            >
              <span className={`codez-agent-task-dot ${t.status}`} />
              <span className="codez-agent-task-title">{t.title || "Untitled task"}</span>
              <span className="codez-agent-task-count">{t.message_count}</span>
              <button
                className="codez-agent-task-del"
                title="Delete task"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeTask(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="codez-agent-main">
        <div className="codez-agent-steps" ref={scrollRef}>
          {steps.length === 0 && (
            <div className="codez-agent-empty">
              <div className="codez-agent-title">Agent mode</div>
              <p className="codez-agent-sub">
                Describe a goal. The agent plans, edits files, and runs tools in
                {projectDir ? ` ${projectDir}` : " the open project"} — then review the
                resulting changes below.
              </p>
              {!projectDir && (
                <p className="codez-agent-note">Open a project folder to start.</p>
              )}
            </div>
          )}
          {steps.map((m, i) => (
            <div key={i} className={`codez-msg ${m.role}`}>
              <div className="codez-msg-role">{m.role === "user" ? "Goal" : "Agent"}</div>
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
              {m.role === "assistant" && !m.text && busy && i === steps.length - 1 && (
                <div className="codez-msg-text codez-thinking">Working…</div>
              )}
            </div>
          ))}
        </div>

        {error && <div className="codez-agent-error">{error}</div>}

        <div className="codez-agent-changes">
          <div className="codez-agent-changes-head">
            <span>Changes {changes.length > 0 ? `(${changes.length})` : ""}</span>
            <button onClick={refreshChanges} disabled={!projectDir} title="Refresh git status">
              ⟳
            </button>
          </div>
          {changes.length === 0 ? (
            <div className="codez-agent-changes-empty">No uncommitted changes.</div>
          ) : (
            <div className="codez-agent-changes-list">
              {changes.map((c) => (
                <div key={c.path} className="codez-agent-change">
                  <span className={`codez-agent-change-badge ${c.status}`}>
                    {c.status.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="codez-agent-change-path">{c.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="codez-agent-composer">
          <textarea
            ref={taRef}
            value={goal}
            placeholder={
              busy
                ? "Agent is working…"
                : "Describe a task for the agent  (Cmd/Ctrl+Enter to run)"
            }
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={busy}
          />
          {busy ? (
            <button className="codez-agent-stop" onClick={() => void chatCancel()}>
              Stop
            </button>
          ) : (
            <button className="codez-agent-run" onClick={run} disabled={!goal.trim()}>
              Run
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
