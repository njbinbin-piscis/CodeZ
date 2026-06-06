import { useCallback, useEffect, useState } from "react";
import {
  getConnectorCredentials,
  installConnector,
  listConnectors,
  saveConnectorCredentials,
  setConnectorEnabled,
  uninstallConnector,
  type ConnectorInfo,
} from "../../../services/tauri/connectors";

/**
 * Settings tab: connectors — authenticated external services (通达信 / 腾讯文档 /
 * 飞书·钉钉·企微 数据接口 …) registered as MCP tools for the agent. Install a
 * connector.json, fill in credentials to authorize, then enable it.
 */
export default function ConnectorsTab() {
  const [items, setItems] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("");

  // Credential editing state keyed by connector id.
  const [editing, setEditing] = useState<string | null>(null);
  const [credForm, setCredForm] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listConnectors());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doInstall = useCallback(async () => {
    if (!source.trim()) return;
    setBusy("__install__");
    setError(null);
    try {
      await installConnector(source.trim());
      setSource("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [source, refresh]);

  const doUninstall = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await uninstallConnector(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const doToggle = useCallback(
    async (c: ConnectorInfo) => {
      setBusy(c.id);
      setError(null);
      try {
        await setConnectorEnabled(c.id, !c.enabled);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const openCreds = useCallback(async (c: ConnectorInfo) => {
    setEditing(c.id);
    setError(null);
    try {
      setCredForm(await getConnectorCredentials(c.id));
    } catch {
      setCredForm({});
    }
  }, []);

  const saveCreds = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await saveConnectorCredentials(id, credForm);
        setEditing(null);
        setCredForm({});
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [credForm, refresh],
  );

  if (loading) {
    return <div className="codez-settings-loading">加载中…</div>;
  }

  return (
    <div className="codez-settings-tabpanel">
      <section className="codez-settings-section">
        <h3>连接器</h3>
        <p className="codez-settings-hint">
          连接带授权的外部服务（通达信、腾讯文档、QQ邮箱、飞书/钉钉/企微的 OA 与数据接口等），
          底层以 MCP 形式暴露给 Agent。安装 connector.json → 填写凭证授权 → 启用。
        </p>
        {error && <div className="codez-settings-error">{error}</div>}

        <div className="codez-wb-search">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doInstall();
            }}
            placeholder="connector.json 路径 / 目录 / https URL"
          />
          <button type="button" onClick={() => void doInstall()} disabled={busy === "__install__"}>
            {busy === "__install__" ? "安装中…" : "安装"}
          </button>
        </div>

        {items.length === 0 ? (
          <div className="codez-wb-empty">尚未安装任何连接器</div>
        ) : (
          <div className="codez-wb-list">
            {items.map((c) => (
              <div key={c.id} className="codez-wb-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div className="codez-wb-info">
                    <strong>
                      {c.icon ? `${c.icon} ` : ""}
                      {c.name}
                    </strong>
                    <span className="codez-wb-meta">
                      {c.id}
                      {c.category ? ` · ${c.category}` : ""}
                      {` · 鉴权: ${c.auth_method}`}
                      {c.authorized ? " · ✅ 已授权" : " · ⚠️ 未授权"}
                      {c.enabled ? " · 已启用" : ""}
                    </span>
                    {c.description && <span className="codez-wb-desc">{c.description}</span>}
                  </div>
                  <div className="codez-wb-actions" style={{ flexShrink: 0 }}>
                    {c.auth_method !== "none" && (
                      <button type="button" onClick={() => void openCreds(c)}>
                        凭证
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy === c.id || (!c.authorized && !c.enabled)}
                      onClick={() => void doToggle(c)}
                    >
                      {c.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy === c.id}
                      onClick={() => void doUninstall(c.id)}
                    >
                      卸载
                    </button>
                  </div>
                </div>

                {editing === c.id && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: 8,
                      borderRadius: 6,
                      background: "rgba(127,127,127,0.08)",
                    }}
                  >
                    {c.fields.length === 0 && (
                      <span className="codez-wb-meta">该连接器未声明凭证字段</span>
                    )}
                    {c.fields.map((f) => (
                      <input
                        key={f.key}
                        type={f.secret ? "password" : "text"}
                        placeholder={f.placeholder || f.label || f.key}
                        value={credForm[f.key] ?? ""}
                        onChange={(e) =>
                          setCredForm((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                      />
                    ))}
                    {c.auth_method === "oauth2" && (
                      <span className="codez-wb-meta">
                        OAuth2 一键授权流程将在后续内核升级后接入；当前可手动填入已获取的
                        token。
                      </span>
                    )}
                    <div className="codez-wb-actions">
                      <button type="button" onClick={() => void saveCreds(c.id)} disabled={busy === c.id}>
                        保存凭证
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setCredForm({});
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
