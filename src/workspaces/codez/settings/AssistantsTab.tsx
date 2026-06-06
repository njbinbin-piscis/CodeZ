import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectGatewayChannels,
  disconnectGatewayChannels,
  getImSettings,
  listGatewayChannels,
  pollWechatLogin,
  saveImSettings,
  startWechatLogin,
  type ChannelInfo,
  type ChannelStatus,
  type ImSettings,
} from "../../../services/tauri/gateway";

const EMPTY: ImSettings = {
  feishu_app_id: "",
  feishu_app_secret: "",
  feishu_domain: "feishu",
  feishu_enabled: false,
  wecom_bot_id: "",
  wecom_bot_secret: "",
  wecom_enabled: false,
  dingtalk_app_key: "",
  dingtalk_app_secret: "",
  dingtalk_robot_code: "",
  dingtalk_enabled: false,
  telegram_bot_token: "",
  telegram_enabled: false,
  slack_webhook_url: "",
  slack_enabled: false,
  discord_webhook_url: "",
  discord_enabled: false,
  teams_webhook_url: "",
  teams_enabled: false,
  matrix_homeserver: "",
  matrix_access_token: "",
  matrix_room_id: "",
  matrix_enabled: false,
  webhook_outbound_url: "",
  webhook_auth_token: "",
  webhook_enabled: false,
  wechat_enabled: false,
  wechat_gateway_port: 18788,
  wechat_bot_id: "",
  im_message_mode: "queue",
};

function statusLabel(s: ChannelStatus): { text: string; color: string } {
  if (s === "Connected") return { text: "已连接", color: "#3fb950" };
  if (s === "Connecting") return { text: "连接中", color: "#d29922" };
  if (s === "Disconnected") return { text: "未连接", color: "#8b949e" };
  if (typeof s === "object" && "Error" in s)
    return { text: `错误: ${s.Error}`, color: "#f85149" };
  return { text: String(s), color: "#8b949e" };
}

/**
 * Settings tab: IM "assistants" — connect Feishu / WeCom / DingTalk / WeChat etc.
 * so inbound chat messages drive a headless agent turn and the reply is sent back.
 */
export default function AssistantsTab() {
  const [form, setForm] = useState<ImSettings>(EMPTY);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // WeChat QR login state.
  const [qr, setQr] = useState<string | null>(null);
  const [qrMsg, setQrMsg] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const set = <K extends keyof ImSettings>(key: K, value: ImSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, st] = await Promise.all([getImSettings(), listGatewayChannels()]);
      setForm(s);
      setChannels(st.channels);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [refresh]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveImSettings(form);
      setForm(saved);
      setNotice("已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [form]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveImSettings(form);
      const st = await connectGatewayChannels();
      setChannels(st.channels);
      setNotice("已连接启用的渠道");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [form]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectGatewayChannels();
      setChannels([]);
      setNotice("已断开所有渠道");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const beginWechat = useCallback(async () => {
    setError(null);
    setQr(null);
    setQrMsg("正在获取二维码…");
    try {
      const res = await startWechatLogin();
      setQr(res.qr_data_url);
      setQrMsg("请使用微信扫码登录");
      const token = res.qrcode_token;
      if (!token) return;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      pollTimer.current = window.setInterval(async () => {
        try {
          const st = await pollWechatLogin(token);
          if (st.message === "scaned") setQrMsg("已扫码，请在手机上确认");
          if (st.connected) {
            setQrMsg("微信已连接");
            setQr(null);
            if (pollTimer.current) window.clearInterval(pollTimer.current);
            await refresh();
          } else if (st.message === "expired") {
            setQrMsg("二维码已过期，请重试");
            setQr(null);
            if (pollTimer.current) window.clearInterval(pollTimer.current);
          }
        } catch (e) {
          setQrMsg(`轮询失败: ${e}`);
          if (pollTimer.current) window.clearInterval(pollTimer.current);
        }
      }, 2500);
    } catch (e) {
      setQrMsg(null);
      setError(String(e));
    }
  }, [refresh]);

  if (loading) {
    return <div className="agentz-settings-loading">加载中…</div>;
  }

  const statusOf = (name: string) => channels.find((c) => c.name === name)?.status;

  const renderStatus = (name: string) => {
    const s = statusOf(name);
    if (!s) return null;
    const { text, color } = statusLabel(s);
    return (
      <span className="agentz-wb-meta" style={{ color }}>
        ● {text}
      </span>
    );
  };

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>助理（IM 渠道）</h3>
        <p className="agentz-settings-hint">
          连接飞书 / 企业微信 / 钉钉 / 微信等即时通讯平台，收到的消息会驱动一次无界面 Agent
          回合，并把回复发回原渠道。凭证保存在本地 config.json（密钥加密存储）。
        </p>
        {error && <div className="agentz-settings-error">{error}</div>}
        {notice && <div className="agentz-settings-hint">{notice}</div>}

        {/* 飞书 */}
        <div className="agentz-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.feishu_enabled}
              onChange={(e) => set("feishu_enabled", e.target.checked)}
            />
            <strong>飞书 / Lark</strong>
            {renderStatus("feishu")}
          </label>
          <input
            placeholder="App ID"
            value={form.feishu_app_id}
            onChange={(e) => set("feishu_app_id", e.target.value)}
          />
          <input
            placeholder="App Secret"
            type="password"
            value={form.feishu_app_secret}
            onChange={(e) => set("feishu_app_secret", e.target.value)}
          />
          <select
            value={form.feishu_domain}
            onChange={(e) => set("feishu_domain", e.target.value)}
          >
            <option value="feishu">feishu（飞书，国内）</option>
            <option value="lark">lark（海外）</option>
          </select>
        </div>

        {/* 企业微信 */}
        <div className="agentz-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.wecom_enabled}
              onChange={(e) => set("wecom_enabled", e.target.checked)}
            />
            <strong>企业微信（智能机器人）</strong>
            {renderStatus("wecom")}
          </label>
          <input
            placeholder="Bot ID"
            value={form.wecom_bot_id}
            onChange={(e) => set("wecom_bot_id", e.target.value)}
          />
          <input
            placeholder="Bot Secret"
            type="password"
            value={form.wecom_bot_secret}
            onChange={(e) => set("wecom_bot_secret", e.target.value)}
          />
        </div>

        {/* 钉钉 */}
        <div className="agentz-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.dingtalk_enabled}
              onChange={(e) => set("dingtalk_enabled", e.target.checked)}
            />
            <strong>钉钉</strong>
            {renderStatus("dingtalk")}
          </label>
          <input
            placeholder="App Key"
            value={form.dingtalk_app_key}
            onChange={(e) => set("dingtalk_app_key", e.target.value)}
          />
          <input
            placeholder="App Secret"
            type="password"
            value={form.dingtalk_app_secret}
            onChange={(e) => set("dingtalk_app_secret", e.target.value)}
          />
          <input
            placeholder="Robot Code（可选，启用主动发送）"
            value={form.dingtalk_robot_code}
            onChange={(e) => set("dingtalk_robot_code", e.target.value)}
          />
        </div>

        {/* 微信 */}
        <div className="agentz-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.wechat_enabled}
              onChange={(e) => set("wechat_enabled", e.target.checked)}
            />
            <strong>微信（iLink 扫码）</strong>
            {renderStatus("wechat")}
          </label>
          <div style={{ fontSize: 12, color: "#8b949e" }}>
            {form.wechat_bot_id ? `已绑定 bot_id: ${form.wechat_bot_id}` : "未绑定，请扫码登录"}
          </div>
          <div className="agentz-wb-actions">
            <button type="button" onClick={() => void beginWechat()}>
              扫码登录
            </button>
          </div>
          {qrMsg && <div className="agentz-settings-hint">{qrMsg}</div>}
          {qr && (
            <img
              src={qr}
              alt="微信登录二维码"
              style={{ width: 200, height: 200, background: "#fff", padding: 8, borderRadius: 6 }}
            />
          )}
        </div>

        {/* 消息处理模式 */}
        <div className="agentz-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>消息处理模式</strong>
          </label>
          <select
            value={form.im_message_mode || "queue"}
            onChange={(e) => set("im_message_mode", e.target.value)}
          >
            <option value="queue">queue（排队：先完成当前任务）</option>
            <option value="cancel">cancel（取消：新消息打断旧任务）</option>
          </select>
        </div>

        <div className="agentz-wb-actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
          <button type="button" onClick={() => void connect()} disabled={busy}>
            保存并连接
          </button>
          <button type="button" className="danger" onClick={() => void disconnect()} disabled={busy}>
            全部断开
          </button>
        </div>
      </section>
    </div>
  );
}
