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
 * recent pool_chat / event feed. Refreshes on every `codez:pool-event`.
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
    <div className="codez-collab-overlay" onClick={onClose}>
      <div className="codez-collab" onClick={(e) => e.stopPropagation()}>
        <div className="codez-collab-head">
          <div>
            <strong>{pool?.name ?? t("collab.title")}</strong>
            {pool && <span className={`codez-collab-status ${pool.status}`}>{pool.status}</span>}
          </div>
          <button type="button" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>

        <div className="codez-collab-members">
          {members.length === 0 && <span className="codez-collab-empty">{t("collab.noMembers")}</span>}
          {members.map((m) => (
            <div key={m.koi_id} className="codez-collab-member" title={m.role}>
              <span className="codez-collab-member-icon" style={{ background: m.color || "#7c6af7" }}>
                {m.icon || "🐟"}
              </span>
              <span className="codez-collab-member-name">{m.name}</span>
              <span className={`codez-collab-member-status ${m.status}`}>{m.status}</span>
            </div>
          ))}
        </div>

        <div className="codez-collab-board">
          {columns.map((col) => (
            <div key={col.key} className="codez-collab-col">
              <div className="codez-collab-col-head">
                {t(`collab.col_${col.key}`)} <span>{col.items.length}</span>
              </div>
              <div className="codez-collab-col-body">
                {col.items.map((td) => (
                  <div key={td.id} className={`codez-collab-card ${td.status}`}>
                    <div className="codez-collab-card-title">{td.title}</div>
                    <div className="codez-collab-card-meta">
                      <span className={`codez-collab-prio ${td.priority}`}>{td.priority}</span>
                      <span>{memberName(td.owner_id)}</span>
                    </div>
                  </div>
                ))}
                {col.items.length === 0 && <div className="codez-collab-col-empty">—</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="codez-collab-feed">
          <div className="codez-collab-feed-head">{t("collab.feed")}</div>
          <div className="codez-collab-feed-body">
            {messages.length === 0 && <div className="codez-collab-empty">{t("collab.noMessages")}</div>}
            {messages.map((msg) => (
              <div key={msg.id} className={`codez-collab-msg ${msg.msg_type}`}>
                <span className="codez-collab-msg-sender">{memberName(msg.sender_id)}</span>
                <span className="codez-collab-msg-content">{msg.content}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
