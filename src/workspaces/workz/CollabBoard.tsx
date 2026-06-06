import { useCallback, useEffect, useMemo, useState } from "react";
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
import "./CollabBoard.css";

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

  const memberName = useCallback(
    (koiId: string) => members.find((m) => m.koi_id === koiId)?.name ?? koiId,
    [members],
  );

  const columns = useMemo(
    () =>
      TODO_COLUMNS.map((col) => ({
        key: col.key,
        items: todos.filter((td) => col.statuses.includes(td.status)),
      })),
    [todos],
  );

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
