import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  poolGet,
  poolMembers,
  poolTodos,
  poolMessages,
  onPoolEvent,
  type PoolSession,
  type PoolMember,
  type KoiTodo,
  type PoolMessage,
} from "../../services/tauri/pool";
import { onChatEvent, type AgentEvent, type ChatEventEnvelope } from "../../services/tauri/chat";
import "./CollabBoard.css";

/** Live koi-turn output is keyed by this session id (see kernel pool dispatch). */
const koiTaskSessionId = (td: KoiTodo) => `koi_task_${td.owner_id}_${td.id.slice(0, 8)}`;

/** Keep only the tail of each agent's live buffer so the board can't grow unbounded. */
const CLI_BUFFER_LIMIT = 4000;

/**
 * 2-line CLI window that auto-scrolls to the latest output as it streams in.
 */
function CardCli({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre ref={ref} className="agentz-collab-card-cli">
      {text || t("collab.cliWaiting")}
    </pre>
  );
}

interface CollabBoardProps {
  projectDir: string;
  poolId: string;
  onClose: () => void;
}

const TODO_COLUMNS: { key: string; statuses: string[] }[] = [
  { key: "todo", statuses: ["todo"] },
  { key: "inProgress", statuses: ["in_progress", "blocked"] },
  { key: "done", statuses: ["done", "completed"] },
];

/**
 * Live collaboration board for a team Pool: members, a todo kanban, and the
 * recent pool_chat / event feed. Refreshes on every `agentz:pool-event`.
 */
export default function CollabBoard({ projectDir, poolId, onClose }: CollabBoardProps) {
  const { t } = useTranslation();
  const [pool, setPool] = useState<PoolSession | null>(null);
  const [members, setMembers] = useState<PoolMember[]>([]);
  const [todos, setTodos] = useState<KoiTodo[]>([]);
  const [messages, setMessages] = useState<PoolMessage[]>([]);
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [p, m, td, msg] = await Promise.all([
        poolGet(projectDir, poolId),
        poolMembers(projectDir, poolId),
        poolTodos(projectDir, poolId),
        poolMessages(projectDir, poolId, 60, 0),
      ]);
      setPool(p);
      setMembers(m);
      setTodos(td);
      setMessages(msg);
    } catch {
      // best-effort; board polls again on the next event
    }
  }, [projectDir, poolId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    onPoolEvent(() => {
      // Debounce bursts of events into a single refresh.
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 250);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh]);

  // Stream each working koi's tokens into a per-session buffer. Koi turns emit
  // over the shared chat channel keyed by `koi_task_{owner}_{todo8}`.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onChatEvent((env: ChatEventEnvelope) => {
      if (env.channel !== "agent_event") return;
      if (!env.sessionId || !env.sessionId.startsWith("koi_task_")) return;
      const sid = env.sessionId;
      const evt = env.payload as AgentEvent;
      let chunk = "";
      if (evt.type === "text_delta") {
        chunk = evt.delta;
      } else if (evt.type === "tool_start") {
        chunk = `\n▸ ${evt.name}\n`;
      } else {
        return;
      }
      setLiveOutput((prev) => {
        const next = (prev[sid] ?? "") + chunk;
        return {
          ...prev,
          [sid]: next.length > CLI_BUFFER_LIMIT ? next.slice(next.length - CLI_BUFFER_LIMIT) : next,
        };
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const memberName = useCallback(
    (koiId: string) => {
      if (koiId === "piscis") return t("agent.role");
      return members.find((m) => m.koi_id === koiId)?.name ?? koiId;
    },
    [members, t],
  );

  const columns = useMemo(
    () =>
      TODO_COLUMNS.map((col) => ({
        key: col.key,
        items: todos.filter((td) => col.statuses.includes(td.status)),
      })),
    [todos],
  );

  const dependencyWaiting = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.event_type === "dependency_waiting" && msg.todo_id) {
        map.set(msg.todo_id, msg.content);
      }
    }
    return map;
  }, [messages]);

  return (
    <div className="agentz-collab-overlay" onClick={onClose}>
      <div className="agentz-collab" onClick={(e) => e.stopPropagation()}>
        <div className="agentz-collab-head">
          <div>
            <strong>{pool?.name ?? t("collab.title")}</strong>
            {pool && <span className={`agentz-collab-status ${pool.status}`}>{pool.status}</span>}
          </div>
          <button type="button" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>

        <div className="agentz-collab-members">
          {members.length === 0 && <span className="agentz-collab-empty">{t("collab.noMembers")}</span>}
          {members.map((m) => (
            <div key={m.koi_id} className="agentz-collab-member" title={m.role}>
              <span className="agentz-collab-member-icon" style={{ background: m.color || "#7c6af7" }}>
                {m.icon || "🐟"}
              </span>
              <span className="agentz-collab-member-name">{m.name}</span>
              <span className={`agentz-collab-member-status ${m.status}`}>{m.status}</span>
            </div>
          ))}
        </div>

        <div className="agentz-collab-board">
          {columns.map((col) => (
            <div key={col.key} className="agentz-collab-col">
              <div className="agentz-collab-col-head">
                {t(`collab.col_${col.key}`)} <span>{col.items.length}</span>
              </div>
              <div className="agentz-collab-col-body">
                {col.items.map((td) => (
                  <div key={td.id} className={`agentz-collab-card ${td.status}`}>
                    <div className="agentz-collab-card-title">{td.title}</div>
                    <div className="agentz-collab-card-meta">
                      <span className={`agentz-collab-prio ${td.priority}`}>{td.priority}</span>
                      <span>{memberName(td.owner_id)}</span>
                    </div>
                    {td.status === "in_progress" && (
                      <CardCli text={liveOutput[koiTaskSessionId(td)] ?? ""} />
                    )}
                    {(dependencyWaiting.has(td.id) || td.depends_on) && (
                      <div className="agentz-collab-card-wait">
                        {dependencyWaiting.get(td.id) ??
                          t("agent.todoWaitingDependency", { id: td.depends_on ?? "?" })}
                      </div>
                    )}
                  </div>
                ))}
                {col.items.length === 0 && <div className="agentz-collab-col-empty">—</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="agentz-collab-feed">
          <div className="agentz-collab-feed-head">{t("collab.feed")}</div>
          <div className="agentz-collab-feed-body">
            {messages.length === 0 && <div className="agentz-collab-empty">{t("collab.noMessages")}</div>}
            {messages.map((msg) => (
              <div key={msg.id} className={`agentz-collab-msg ${msg.msg_type}`}>
                <span className="agentz-collab-msg-sender">{memberName(msg.sender_id)}</span>
                <span className="agentz-collab-msg-content">{msg.content}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
