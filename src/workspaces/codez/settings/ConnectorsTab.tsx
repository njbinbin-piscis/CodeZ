import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createApiConnector,
  getConnectorCredentials,
  installConnector,
  listConnectors,
  saveConnectorCredentials,
  setConnectorEnabled,
  uninstallConnector,
  type ConnectorInfo,
  type CreateApiConnectorRequest,
} from "../../../services/tauri/connectors";

const API_PRESETS: Array<{
  id: string;
  icon: string;
  category: string;
  use_case: string;
  parameters: string;
}> = [
  {
    id: "seedance-video",
    icon: "🎬",
    category: "video",
    use_case: "Generate short video clips from text prompts (SeedDance / similar APIs).",
    parameters: '{"prompt": "string", "duration_sec": "number", "aspect_ratio": "16:9|9:16"}',
  },
  {
    id: "asr-speech",
    icon: "🎙️",
    category: "asr",
    use_case: "Transcribe audio to text (speech recognition).",
    parameters: '{"audio_url": "string", "language": "zh|en"}',
  },
  {
    id: "tts-voice",
    icon: "🔊",
    category: "tts",
    use_case: "Synthesize speech audio from text.",
    parameters: '{"text": "string", "voice": "string", "format": "mp3|wav"}',
  },
  {
    id: "ocr-text",
    icon: "📄",
    category: "ocr",
    use_case: "Extract text from images or scanned documents.",
    parameters: '{"image_url": "string", "language": "zh|en"}',
  },
];

const EMPTY_API: CreateApiConnectorRequest = {
  id: "",
  name: "",
  url: "",
  api_key: "",
  use_case: "",
  parameters: "",
  method: "POST",
  category: "api",
  icon: "🔌",
  description: "",
};

export default function ConnectorsTab() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [apiOpen, setApiOpen] = useState(false);
  const [apiForm, setApiForm] = useState<CreateApiConnectorRequest>(EMPTY_API);

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

  const applyPreset = useCallback((presetId: string) => {
    const p = API_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setApiForm((f) => ({
      ...f,
      id: f.id || p.id,
      name: f.name || p.id.replace(/-/g, " "),
      icon: p.icon,
      category: p.category,
      use_case: p.use_case,
      parameters: p.parameters,
    }));
  }, []);

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

  const doCreateApi = useCallback(async () => {
    setBusy("__api__");
    setError(null);
    try {
      await createApiConnector(apiForm);
      setApiForm(EMPTY_API);
      setApiOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [apiForm, refresh]);

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
    return <div className="agentz-settings-loading">{t("common.loading")}</div>;
  }

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>{t("connectors.title")}</h3>
        <p className="agentz-settings-hint">{t("connectors.hint")}</p>
        {error && <div className="agentz-settings-error">{error}</div>}

        <div className="agentz-wb-search">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doInstall();
            }}
            placeholder={t("connectors.installPlaceholder")}
          />
          <button type="button" onClick={() => void doInstall()} disabled={busy === "__install__"}>
            {busy === "__install__" ? t("connectors.installing") : t("connectors.install")}
          </button>
        </div>

        <div className="agentz-settings-field" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setApiOpen((v) => !v)}>
            {apiOpen ? t("connectors.apiHide") : t("connectors.apiNew")}
          </button>
        </div>

        {apiOpen && (
          <div className="agentz-settings-section" style={{ marginTop: 8 }}>
            <p className="agentz-settings-hint">{t("connectors.apiHint")}</p>
            <div className="agentz-settings-field">
              <label>{t("connectors.apiPreset")}</label>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) applyPreset(e.target.value);
                }}
              >
                <option value="">{t("connectors.apiPresetCustom")}</option>
                {API_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} {p.category.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="agentz-studio-grid">
              <div className="agentz-settings-field">
                <label>{t("connectors.apiId")}</label>
                <input
                  value={apiForm.id}
                  onChange={(e) => setApiForm({ ...apiForm, id: e.target.value })}
                  placeholder="my-video-api"
                />
              </div>
              <div className="agentz-settings-field">
                <label>{t("connectors.apiName")}</label>
                <input
                  value={apiForm.name}
                  onChange={(e) => setApiForm({ ...apiForm, name: e.target.value })}
                />
              </div>
            </div>
            <div className="agentz-settings-field">
              <label>{t("connectors.apiUrl")}</label>
              <input
                value={apiForm.url}
                onChange={(e) => setApiForm({ ...apiForm, url: e.target.value })}
                placeholder="https://api.example.com/v1/generate"
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("connectors.apiKey")}</label>
              <input
                type="password"
                value={apiForm.api_key}
                onChange={(e) => setApiForm({ ...apiForm, api_key: e.target.value })}
              />
            </div>
            <div className="agentz-studio-grid">
              <div className="agentz-settings-field">
                <label>{t("connectors.apiMethod")}</label>
                <select
                  value={apiForm.method ?? "POST"}
                  onChange={(e) => setApiForm({ ...apiForm, method: e.target.value })}
                >
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="agentz-settings-field">
                <label>{t("connectors.apiCategory")}</label>
                <input
                  value={apiForm.category ?? ""}
                  onChange={(e) => setApiForm({ ...apiForm, category: e.target.value })}
                />
              </div>
            </div>
            <div className="agentz-settings-field">
              <label>{t("connectors.apiUseCase")}</label>
              <textarea
                rows={3}
                value={apiForm.use_case ?? ""}
                onChange={(e) => setApiForm({ ...apiForm, use_case: e.target.value })}
                placeholder={t("connectors.apiUseCasePlaceholder")}
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("connectors.apiParameters")}</label>
              <textarea
                rows={4}
                value={apiForm.parameters ?? ""}
                onChange={(e) => setApiForm({ ...apiForm, parameters: e.target.value })}
                placeholder='{"prompt": "string", "language": "zh"}'
              />
            </div>
            <div className="agentz-wb-actions">
              <button type="button" onClick={() => void doCreateApi()} disabled={busy === "__api__"}>
                {busy === "__api__" ? t("common.saving") : t("connectors.apiCreate")}
              </button>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <div className="agentz-wb-empty">{t("connectors.empty")}</div>
        ) : (
          <div className="agentz-wb-list">
            {items.map((c) => (
              <div
                key={c.id}
                className="agentz-wb-row"
                style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div className="agentz-wb-info">
                    <strong>
                      {c.icon ? `${c.icon} ` : ""}
                      {c.name}
                      {c.kind === "api" ? ` · ${t("connectors.kindApi")}` : ""}
                    </strong>
                    <span className="agentz-wb-meta">
                      {c.id}
                      {c.category ? ` · ${c.category}` : ""}
                      {` · ${t("connectors.auth")}: ${c.auth_method}`}
                      {c.authorized ? ` · ${t("connectors.authorized")}` : ` · ${t("connectors.unauthorized")}`}
                      {c.enabled ? ` · ${t("connectors.enabled")}` : ""}
                    </span>
                    {c.description && <span className="agentz-wb-desc">{c.description}</span>}
                    {c.kind === "api" && c.use_case && (
                      <span className="agentz-wb-desc">{c.use_case}</span>
                    )}
                    {c.kind === "api" && c.url && (
                      <span className="agentz-wb-meta">{c.url}</span>
                    )}
                  </div>
                  <div className="agentz-wb-actions" style={{ flexShrink: 0 }}>
                    {c.auth_method !== "none" && (
                      <button type="button" onClick={() => void openCreds(c)}>
                        {t("connectors.credentials")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy === c.id || (!c.authorized && !c.enabled)}
                      onClick={() => void doToggle(c)}
                    >
                      {c.enabled ? t("connectors.disable") : t("connectors.enable")}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy === c.id}
                      onClick={() => void doUninstall(c.id)}
                    >
                      {t("connectors.uninstall")}
                    </button>
                  </div>
                </div>

                {editing === c.id && (
                  <div className="agentz-settings-section" style={{ padding: 8 }}>
                    {c.fields.length === 0 && (
                      <span className="agentz-wb-meta">{t("connectors.noCredFields")}</span>
                    )}
                    {c.fields.map((f) => (
                      <div key={f.key} className="agentz-settings-field">
                        <input
                          type={f.secret ? "password" : "text"}
                          placeholder={f.placeholder || f.label || f.key}
                          value={credForm[f.key] ?? ""}
                          onChange={(e) =>
                            setCredForm((prev) => ({ ...prev, [f.key]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                    <div className="agentz-wb-actions">
                      <button type="button" onClick={() => void saveCreds(c.id)} disabled={busy === c.id}>
                        {t("connectors.saveCreds")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setCredForm({});
                        }}
                      >
                        {t("common.cancel")}
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
