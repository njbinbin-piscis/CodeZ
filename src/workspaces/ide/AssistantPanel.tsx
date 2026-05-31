import { useCallback, useEffect, useRef, useState } from "react";
import { chatSend, onChatEvent, type AgentEvent, type ChatEventEnvelope } from "../../services/tauri/chat";
import { ideApi } from "../../services/tauri/ide";
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

export default function AssistantPanel({ projectDir, onClose }: AssistantPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!projectDir) {
      setError("Open a project folder before chatting.");
      return;
    }
    setError(null);
    setMessages((m) => [
      ...m,
      { role: "user", text, tools: [] },
      { role: "assistant", text: "", tools: [] },
    ]);
    setInput("");
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
    }
  }, [input, busy, projectDir]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="codez-assistant">
      <div className="codez-assistant-header">
        <span>AI Chat</span>
        <button className="codez-assistant-close" onClick={onClose} title="Hide chat">
          ✕
        </button>
      </div>

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
            {m.text && <div className="codez-msg-text">{m.text}</div>}
            {m.role === "assistant" && !m.text && busy && i === messages.length - 1 && (
              <div className="codez-msg-text codez-thinking">Thinking…</div>
            )}
          </div>
        ))}
      </div>

      {error && <div className="codez-assistant-error">{error}</div>}

      <div className="codez-assistant-input">
        <textarea
          value={input}
          placeholder={busy ? "Agent is working…" : "Message the agent  (Cmd/Ctrl+Enter to send)"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={3}
        />
        <button onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
