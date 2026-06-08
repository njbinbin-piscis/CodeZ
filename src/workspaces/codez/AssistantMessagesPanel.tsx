import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { CloseIcon } from "../../components/TitleBarIcons";
import {
  clearImSessions,
  connectGatewayChannels,
  disconnectGatewayChannels,
  getImSettings,
  imSessionMessages,
  listGatewayChannels,
  listImSessions,
  type ChannelStatus,
  type ImMessageDto,
  type ImSessionMeta,
} from "../../services/tauri/gateway";
import "./AssistantMessagesPanel.css";

interface AssistantMessagesPanelProps {
  onClose: () => void;
}

/** Channel slugs that, when enabled, surface as assistant tabs. */
function enabledChannels(s: Awaited<ReturnType<typeof getImSettings>>): string[] {
  const out: string[] = [];
  if (s.feishu_enabled) out.push("feishu");
  if (s.wecom_enabled) out.push("wecom");
  if (s.dingtalk_enabled) out.push("dingtalk");
  if (s.telegram_enabled) out.push("telegram");
  if (s.slack_enabled) out.push("slack");
  if (s.discord_enabled) out.push("discord");
  if (s.teams_enabled) out.push("teams");
  if (s.matrix_enabled) out.push("matrix");
  if (s.webhook_enabled) out.push("webhook");
  if (s.wechat_enabled) out.push("wechat");
  return out;
}

const CHANNEL_LABELS: Record<string, string> = {
  feishu: "飞书 Feishu",
  wecom: "企业微信 WeCom",
  dingtalk: "钉钉 DingTalk",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  teams: "Teams",
  matrix: "Matrix",
  webhook: "Webhook",
  wechat: "微信 WeChat",
};

function channelLabel(slug: string): string {
  return CHANNEL_LABELS[slug] ?? slug;
}

function statusText(status: ChannelStatus | undefined): { label: string; tone: string } {
  if (!status || status === "Disconnected") return { label: "未连接", tone: "off" };
  if (status === "Connecting") return { label: "连接中…", tone: "pending" };
  if (status === "Connected") return { label: "已连接", tone: "on" };
  if (typeof status === "object" && "Error" in status) return { label: "错误", tone: "err" };
  return { label: String(status), tone: "off" };
}

export default function AssistantMessagesPanel({ onClose }: AssistantMessagesPanelProps) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, ChannelStatus>>({});
  const [sessions, setSessions] = useState<ImSessionMeta[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ImMessageDto[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await listGatewayChannels();
      const map: Record<string, ChannelStatus> = {};
      for (const c of res.channels) map[c.name] = c.status;
      setStatusMap(map);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSessions = useCallback(async (channel: string | null) => {
    if (!channel) {
      setSessions([]);
      return;
    }
    try {
      const list = await listImSessions(channel);
      setSessions(list);
      setActiveSession((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch {
      setSessions([]);
    }
  }, []);

  // Initial load: enabled channels + statuses.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await getImSettings();
        if (!alive) return;
        const chans = enabledChannels(s);
        setChannels(chans);
        setActive((prev) => prev ?? chans[0] ?? null);
      } catch {
        /* ignore */
      }
      await refreshStatus();
    })();
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  // Reload sessions when the active channel changes.
  useEffect(() => {
    void refreshSessions(active);
  }, [active, refreshSessions]);

  // Load messages for the active session.
  const refreshMessages = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    try {
      setMessages(await imSessionMessages(sessionId));
    } catch {
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    void refreshMessages(activeSession);
  }, [activeSession, refreshMessages]);

  // Live updates: an IM session changed (new inbound/outbound message).
  useEffect(() => {
    const un = listen<string>("agentz:im-session-updated", () => {
      void refreshSessions(active);
      void refreshMessages(activeSession);
      void refreshStatus();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [active, activeSession, refreshSessions, refreshMessages, refreshStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const activeStatus = useMemo(() => statusMap[active ?? ""], [statusMap, active]);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      await connectGatewayChannels();
    } catch {
      /* ignore */
    } finally {
      await refreshStatus();
      setBusy(false);
    }
  }, [refreshStatus]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await disconnectGatewayChannels();
    } catch {
      /* ignore */
    } finally {
      await refreshStatus();
      setBusy(false);
    }
  }, [refreshStatus]);

  const handleClear = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      await clearImSessions(active);
      setMessages([]);
      await refreshSessions(active);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, [active, refreshSessions]);

  const st = statusText(activeStatus);

  return (
    <div className="agentz-assistant-overlay" role="dialog" aria-modal="true">
      <div className="agentz-assistant-panel">
        <header className="agentz-assistant-head">
          <div className="agentz-assistant-title">{t("assistantPanel.title")}</div>
          <button
            type="button"
            className="agentz-assistant-close"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <CloseIcon />
          </button>
        </header>

        {channels.length === 0 ? (
          <div className="agentz-assistant-empty">{t("assistantPanel.empty")}</div>
        ) : (
          <>
            <div className="agentz-assistant-tabs" role="tablist">
              {channels.map((c) => {
                const cst = statusText(statusMap[c]);
                return (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={active === c}
                    className={`agentz-assistant-tab ${active === c ? "active" : ""}`}
                    onClick={() => setActive(c)}
                  >
                    <span className={`agentz-assistant-dot ${cst.tone}`} />
                    {channelLabel(c)}
                  </button>
                );
              })}
            </div>

            <div className="agentz-assistant-toolbar">
              <span className={`agentz-assistant-status ${st.tone}`}>{st.label}</span>
              <div className="agentz-assistant-actions">
                <button type="button" onClick={() => void handleConnect()} disabled={busy}>
                  {t("assistantPanel.connect")}
                </button>
                <button type="button" onClick={() => void handleDisconnect()} disabled={busy}>
                  {t("assistantPanel.disconnect")}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleClear()}
                  disabled={busy}
                >
                  {t("assistantPanel.clear")}
                </button>
              </div>
            </div>

            <div className="agentz-assistant-body">
              <aside className="agentz-assistant-sessions">
                {sessions.length === 0 ? (
                  <div className="agentz-assistant-sessions-empty">
                    {t("assistantPanel.noMessages")}
                  </div>
                ) : (
                  sessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`agentz-assistant-session ${activeSession === s.id ? "active" : ""}`}
                      onClick={() => setActiveSession(s.id)}
                    >
                      <span className="agentz-assistant-session-title">
                        {s.title || s.id.slice(0, 8)}
                      </span>
                      <span className="agentz-assistant-session-count">{s.message_count}</span>
                    </button>
                  ))
                )}
              </aside>

              <div className="agentz-assistant-messages" ref={scrollRef}>
                {messages.length === 0 ? (
                  <div className="agentz-assistant-messages-empty">
                    {t("assistantPanel.noMessages")}
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`agentz-assistant-msg ${m.role === "user" ? "in" : "out"}`}
                    >
                      <div className="agentz-assistant-msg-role">
                        {m.role === "user"
                          ? t("assistantPanel.roleUser")
                          : t("assistantPanel.roleAssistant")}
                      </div>
                      <div className="agentz-assistant-msg-content">{m.content}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
