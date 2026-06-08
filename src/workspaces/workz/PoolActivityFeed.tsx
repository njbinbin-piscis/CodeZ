import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  poolMembers,
  poolMessages,
  onPoolEvent,
  type PoolMember,
  type PoolMessage,
} from "../../services/tauri/pool";
import { getMessages, type MessageDto } from "../../services/tauri/chat";
import Markdown from "../codez/Markdown";
import "./PoolActivityFeed.css";

/**
 * `chat`   → natural-language pool_chat between WorkZ (coordinator) and Koi.
 * `events` → task lifecycle / coordination records (assign, claim, done, fail).
 * `all`    → everything (default).
 */
export type PoolFeedFilter = "all" | "chat" | "events";

interface PoolActivityFeedProps {
  projectDir: string;
  poolId: string;
  filter?: PoolFeedFilter;
}

/** Backend stores the coordinator under the engine id "piscis"; WorkZ shows it as the coordinator. */
const COORDINATOR_SENDER_ID = "piscis";

/** A pool message belongs to the "coordination records" bucket when it carries a lifecycle event. */
function isCoordinationEvent(msg: PoolMessage): boolean {
  if (msg.event_type && msg.event_type.trim()) return true;
  return msg.msg_type === "status_update";
}

function parseMeta(metadata: string): Record<string, unknown> {
  try {
    return JSON.parse(metadata || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatTime(iso: string): string {
  let dateStr = iso;
  if (!/[Zz]$/.test(dateStr) && !/[+-]\d{2}:\d{2}$/.test(dateStr)) {
    dateStr = `${iso}Z`;
  }
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Pool transcript for a WorkZ team: Koi assignments, step results, and chat.
 * Filterable into the Koi chatroom (conversation) vs coordination records
 * (task lifecycle). Click a row to inspect the linked Koi session transcript.
 */
export default function PoolActivityFeed({ projectDir, poolId, filter = "all" }: PoolActivityFeedProps) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<PoolMember[]>([]);
  const [messages, setMessages] = useState<PoolMessage[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);
  const [detailSteps, setDetailSteps] = useState<MessageDto[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, msg] = await Promise.all([
        poolMembers(projectDir, poolId),
        poolMessages(projectDir, poolId, 120, 0),
      ]);
      setMembers(m);
      setMessages(msg.slice().reverse());
    } catch {
      // best-effort; next pool event will retry
    }
  }, [projectDir, poolId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    onPoolEvent(() => {
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
    (senderId: string) => {
      if (senderId === COORDINATOR_SENDER_ID) return t("agent.role");
      return members.find((m) => m.koi_id === senderId)?.name ?? senderId;
    },
    [members, t],
  );

  const visibleMessages = useMemo(() => {
    if (filter === "all") return messages;
    if (filter === "events") return messages.filter(isCoordinationEvent);
    return messages.filter((m) => !isCoordinationEvent(m));
  }, [messages, filter]);

  const openDetail = useCallback(
    async (msg: PoolMessage) => {
      setDetailId(msg.id);
      const meta = parseMeta(msg.metadata);
      const sessionId =
        (typeof meta.session_id === "string" && meta.session_id) ||
        (typeof meta.koi_session_id === "string" && meta.koi_session_id) ||
        null;
      setDetailSessionId(sessionId);
      if (!sessionId) {
        setDetailSteps([]);
        return;
      }
      setDetailBusy(true);
      try {
        const history = await getMessages(sessionId, projectDir);
        setDetailSteps(history);
      } catch {
        setDetailSteps([]);
      } finally {
        setDetailBusy(false);
      }
    },
    [projectDir],
  );

  const activeMsg = useMemo(
    () => (detailId != null ? messages.find((m) => m.id === detailId) ?? null : null),
    [detailId, messages],
  );

  const emptyText =
    filter === "events"
      ? t("agent.coordinationEmpty")
      : filter === "chat"
        ? t("agent.chatroomEmpty")
        : t("collab.noMessages");

  return (
    <div className="agentz-pool-feed">
      <div className="agentz-pool-feed-list">
        {visibleMessages.length === 0 && (
          <div className="agentz-pool-feed-empty">{emptyText}</div>
        )}
        {visibleMessages.map((msg) => (
          <button
            key={msg.id}
            type="button"
            className={`agentz-pool-feed-row ${detailId === msg.id ? "active" : ""} ${msg.msg_type}`}
            onClick={() => void openDetail(msg)}
          >
            <span className="agentz-pool-feed-time">{formatTime(msg.created_at)}</span>
            <span className="agentz-pool-feed-sender">{memberName(msg.sender_id)}</span>
            {msg.event_type && (
              <span className="agentz-pool-feed-event">{msg.event_type}</span>
            )}
            <span className="agentz-pool-feed-preview">{msg.content.slice(0, 240)}</span>
          </button>
        ))}
      </div>

      {activeMsg && (
        <div className="agentz-pool-feed-detail">
          <div className="agentz-pool-feed-detail-head">
            <strong>{t("agent.poolKoiDetail")}</strong>
            <span>{memberName(activeMsg.sender_id)}</span>
            <button type="button" onClick={() => setDetailId(null)} title={t("common.close")}>
              ✕
            </button>
          </div>
          <div className="agentz-pool-feed-detail-body">
            <div className="agentz-pool-feed-detail-msg">
              <Markdown content={activeMsg.content} />
            </div>
            {detailBusy && <div className="agentz-pool-feed-detail-loading">{t("common.loading")}</div>}
            {!detailBusy && detailSessionId && detailSteps.length > 0 && (
              <div className="agentz-pool-feed-koi-steps">
                {detailSteps.map((step) => (
                  <div key={step.id} className={`agentz-pool-feed-koi-step ${step.role}`}>
                    <span className="agentz-pool-feed-koi-role">
                      {step.role === "user" ? t("chat.you") : memberName(activeMsg.sender_id)}
                    </span>
                    <div className="agentz-pool-feed-koi-text">
                      {step.role === "assistant" ? (
                        <Markdown content={step.content} />
                      ) : (
                        step.content
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!detailBusy && detailSessionId && detailSteps.length === 0 && (
              <div className="agentz-pool-feed-detail-empty">{t("collab.noMessages")}</div>
            )}
            {!detailSessionId && (
              <div className="agentz-pool-feed-detail-empty">{t("collab.noMessages")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
