import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  getSettings,
  saveSettings,
  type LlmProviderConfig,
  type LlmSettings,
  type McpServerConfig,
  type SettingsResponse,
} from "../../services/tauri/settings";
import { setLanguage } from "../../i18n";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  onClose: () => void;
}

const PROVIDER_KEYS = [
  "anthropic",
  "openai",
  "deepseek",
  "qwen",
  "minimax",
  "zhipu",
  "kimi",
  "custom",
] as const;

const MODEL_PLACEHOLDERS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  deepseek: "deepseek-chat",
  qwen: "qwen3-max",
  minimax: "MiniMax-M2.5",
  zhipu: "glm-5",
  kimi: "kimi-k2.5",
  custom: "your-model-id",
};

const KEY_FIELDS: Record<string, keyof LlmSettings> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  deepseek: "deepseek_api_key",
  qwen: "qwen_api_key",
  minimax: "minimax_api_key",
  zhipu: "zhipu_api_key",
  kimi: "kimi_api_key",
  custom: "openai_api_key",
};

const DEFAULT_FORM: LlmSettings = {
  provider: "anthropic",
  model: "",
  custom_base_url: "",
  max_tokens: 0,
  context_window: 0,
  policy_mode: "balanced",
  enable_streaming: true,
  language: "zh",
  vision_enabled: false,
  anthropic_api_key: "",
  openai_api_key: "",
  deepseek_api_key: "",
  qwen_api_key: "",
  minimax_api_key: "",
  zhipu_api_key: "",
  kimi_api_key: "",
  llm_providers: [],
  mcp_servers: [],
};

const EMPTY_MCP_SERVER: McpServerConfig = {
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  url: "",
  env: {},
  enabled: true,
};

const EMPTY_LLM_PROVIDER: LlmProviderConfig = {
  id: "",
  label: "",
  provider: "anthropic",
  model: "",
  api_key: "",
  base_url: "",
  max_tokens: 0,
};

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function toForm(data: SettingsResponse): LlmSettings {
  return {
    provider: data.provider || "anthropic",
    model: data.model || "",
    custom_base_url: data.custom_base_url || "",
    max_tokens: data.max_tokens ?? 0,
    context_window: data.context_window ?? 0,
    policy_mode: data.policy_mode || "balanced",
    enable_streaming: data.enable_streaming ?? true,
    language: data.language === "en" ? "en" : "zh",
    vision_enabled: data.vision_enabled ?? false,
    anthropic_api_key: data.anthropic_api_key || "",
    openai_api_key: data.openai_api_key || "",
    deepseek_api_key: data.deepseek_api_key || "",
    qwen_api_key: data.qwen_api_key || "",
    minimax_api_key: data.minimax_api_key || "",
    zhipu_api_key: data.zhipu_api_key || "",
    kimi_api_key: data.kimi_api_key || "",
    llm_providers: data.llm_providers ?? [],
    mcp_servers: data.mcp_servers ?? [],
  };
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configDir, setConfigDir] = useState("");
  const [configured, setConfigured] = useState(false);
  const [form, setForm] = useState<LlmSettings>(DEFAULT_FORM);
  const [showKey, setShowKey] = useState(false);
  const [llmEditIdx, setLlmEditIdx] = useState<number | null>(null);
  const [llmEditForm, setLlmEditForm] = useState<LlmProviderConfig>(EMPTY_LLM_PROVIDER);
  const [llmShowKey, setLlmShowKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSettings();
        if (cancelled) return;
        setConfigDir(data.config_dir);
        setConfigured(data.is_configured);
        const next = toForm(data);
        setForm(next);
        if (next.language === "zh" || next.language === "en") {
          setLanguage(next.language);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = useCallback(<K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "language" && (value === "zh" || value === "en")) {
        setLanguage(value);
      }
      return next;
    });
  }, []);

  const updateMcp = useCallback((idx: number, patch: Partial<McpServerConfig>) => {
    setForm((prev) => ({
      ...prev,
      mcp_servers: prev.mcp_servers.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await saveSettings(form);
      setConfigured(result.is_configured);
      setForm(toForm(result));
      if (result.language === "zh" || result.language === "en") {
        setLanguage(result.language);
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [form, onClose]);

  const provider = form.provider || "anthropic";
  const apiKeyField = KEY_FIELDS[provider] ?? "anthropic_api_key";
  const apiKeyValue = form[apiKeyField] as string;

  const providerLabel = (p: string) => {
    const map: Record<string, string> = {
      anthropic: t("settings.providerAnthropic"),
      openai: t("settings.providerOpenai"),
      deepseek: t("settings.providerDeepseek"),
      qwen: t("settings.providerQwen"),
      minimax: t("settings.providerMinimax"),
      zhipu: t("settings.providerZhipu"),
      kimi: t("settings.providerKimi"),
      custom: t("settings.providerCustom"),
    };
    return map[p] || p;
  };

  const panel = (
    <div className="codez-settings-overlay" onClick={onClose}>
      <div className="codez-settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codez-settings-header">
          <span>{t("settings.title")}</span>
          <button type="button" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>

        {error && <div className="codez-settings-error">{error}</div>}

        {loading ? (
          <div className="codez-settings-loading">{t("settings.loading")}</div>
        ) : (
          <>
            <div className="codez-settings-body">
              <div className="codez-settings-status">
                <span
                  className={`codez-settings-status-dot ${configured ? "ok" : "missing"}`}
                />
                <span style={{ color: configured ? "#4ade80" : "#f87171" }}>
                  {configured ? t("settings.configuredOk") : t("settings.configuredMissing")}
                </span>
              </div>

              <div className="codez-settings-config-path">
                {t("settings.configDir")}：<code>{configDir || "—"}</code>
                <br />
                {t("settings.configDirHint")}
              </div>

              <section className="codez-settings-section">
                <h3>{t("settings.aiProvider")}</h3>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-language">{t("settings.language")}</label>
                  <select
                    id="codez-settings-language"
                    value={form.language}
                    onChange={(e) => update("language", e.target.value)}
                  >
                    <option value="zh">{t("settings.languageZh")}</option>
                    <option value="en">{t("settings.languageEn")}</option>
                  </select>
                </div>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-provider">{t("settings.provider")}</label>
                  <select
                    id="codez-settings-provider"
                    value={provider}
                    onChange={(e) => update("provider", e.target.value)}
                  >
                    {PROVIDER_KEYS.map((p) => (
                      <option key={p} value={p}>
                        {providerLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-model">{t("settings.model")}</label>
                  <input
                    id="codez-settings-model"
                    value={form.model}
                    onChange={(e) => update("model", e.target.value)}
                    placeholder={MODEL_PLACEHOLDERS[provider] ?? "model-id"}
                  />
                </div>

                {(provider === "custom" || provider === "qwen" || provider === "deepseek") && (
                  <div className="codez-settings-field">
                    <label htmlFor="codez-settings-base-url">{t("settings.baseUrl")}</label>
                    <input
                      id="codez-settings-base-url"
                      value={form.custom_base_url}
                      onChange={(e) => update("custom_base_url", e.target.value)}
                      placeholder={
                        provider === "qwen"
                          ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
                          : provider === "deepseek"
                            ? "https://api.deepseek.com/v1"
                            : "https://api.example.com/v1"
                      }
                    />
                  </div>
                )}

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-api-key">{t("settings.apiKey")}</label>
                  <div className="codez-settings-key-row">
                    <input
                      id="codez-settings-api-key"
                      type={showKey ? "text" : "password"}
                      value={apiKeyValue}
                      onChange={(e) => update(apiKeyField, e.target.value)}
                      placeholder={
                        configured ? t("settings.apiKeyKeep") : t("settings.apiKeyNew")
                      }
                    />
                    <button
                      type="button"
                      className="codez-settings-key-toggle"
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? t("common.hide") : t("common.show")}
                    </button>
                  </div>
                  <p className="codez-settings-hint">{t("settings.apiKeyHint")}</p>
                </div>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-max-tokens">{t("settings.maxTokens")}</label>
                  <input
                    id="codez-settings-max-tokens"
                    type="number"
                    min={0}
                    value={form.max_tokens}
                    onChange={(e) => update("max_tokens", Number(e.target.value) || 0)}
                  />
                  <p className="codez-settings-hint">{t("settings.maxTokensHint")}</p>
                </div>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-context">{t("settings.contextWindow")}</label>
                  <input
                    id="codez-settings-context"
                    type="number"
                    min={0}
                    step={1024}
                    value={form.context_window}
                    onChange={(e) => update("context_window", Number(e.target.value) || 0)}
                  />
                  <p className="codez-settings-hint">{t("settings.contextWindowHint")}</p>
                </div>

                <div className="codez-settings-field">
                  <label htmlFor="codez-settings-policy">{t("settings.policyMode")}</label>
                  <select
                    id="codez-settings-policy"
                    value={form.policy_mode}
                    onChange={(e) => update("policy_mode", e.target.value)}
                  >
                    <option value="balanced">{t("settings.policyBalanced")}</option>
                    <option value="strict">{t("settings.policyStrict")}</option>
                    <option value="dev">{t("settings.policyDev")}</option>
                  </select>
                </div>

                <div className="codez-settings-field">
                  <label className="codez-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.vision_enabled}
                      onChange={(e) => update("vision_enabled", e.target.checked)}
                    />
                    {t("settings.visionEnabled")}
                  </label>
                  <p className="codez-settings-hint">{t("settings.visionEnabledHint")}</p>
                </div>

                <div className="codez-settings-field">
                  <label className="codez-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.enable_streaming}
                      onChange={(e) => update("enable_streaming", e.target.checked)}
                    />
                    {t("settings.enableStreaming")}
                  </label>
                </div>
              </section>

              <section className="codez-settings-section">
                <h3>{t("settings.llmProviders")}</h3>
                <p className="codez-settings-hint">{t("settings.llmProvidersHint")}</p>

                {form.llm_providers.length > 0 && (
                  <div className="codez-llm-provider-list">
                    {form.llm_providers.map((p, idx) => (
                      <div key={p.id} className="codez-llm-provider-row">
                        <div className="codez-llm-provider-info">
                          <strong>{p.label || p.id}</strong>
                          <span className="codez-llm-provider-meta">
                            {p.provider} · {p.model || "—"}
                          </span>
                        </div>
                        <div className="codez-llm-provider-actions">
                          <button
                            type="button"
                            onClick={() => {
                              setLlmEditIdx(idx);
                              setLlmEditForm({ ...p, api_key: "" });
                              setLlmShowKey(false);
                            }}
                          >
                            {t("common.edit")}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              update(
                                "llm_providers",
                                form.llm_providers.filter((_, i) => i !== idx),
                              )
                            }
                          >
                            {t("chat.delete")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {llmEditIdx !== null ? (
                  <div className="codez-llm-provider-form">
                    <h4>{llmEditIdx === -1 ? t("settings.llmProviderAdd") : t("settings.llmProviderEdit")}</h4>
                    <div className="codez-llm-provider-grid">
                      <div className="codez-settings-field">
                        <label>{t("settings.llmProviderId")}</label>
                        <input
                          value={llmEditForm.id}
                          disabled={llmEditIdx !== -1}
                          onChange={(e) => setLlmEditForm((f) => ({ ...f, id: e.target.value }))}
                          placeholder="my-claude"
                        />
                      </div>
                      <div className="codez-settings-field">
                        <label>{t("settings.llmProviderLabel")}</label>
                        <input
                          value={llmEditForm.label}
                          onChange={(e) => setLlmEditForm((f) => ({ ...f, label: e.target.value }))}
                          placeholder="Claude Sonnet"
                        />
                      </div>
                      <div className="codez-settings-field">
                        <label>{t("settings.provider")}</label>
                        <select
                          value={llmEditForm.provider}
                          onChange={(e) => setLlmEditForm((f) => ({ ...f, provider: e.target.value }))}
                        >
                          {PROVIDER_KEYS.map((p) => (
                            <option key={p} value={p}>
                              {providerLabel(p)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="codez-settings-field">
                        <label>{t("settings.model")}</label>
                        <input
                          value={llmEditForm.model}
                          onChange={(e) => setLlmEditForm((f) => ({ ...f, model: e.target.value }))}
                          placeholder={MODEL_PLACEHOLDERS[llmEditForm.provider] ?? "model-id"}
                        />
                      </div>
                      <div className="codez-settings-field codez-llm-span-2">
                        <label>{t("settings.apiKey")}</label>
                        <div className="codez-settings-key-row">
                          <input
                            type={llmShowKey ? "text" : "password"}
                            value={llmEditForm.api_key}
                            onChange={(e) => setLlmEditForm((f) => ({ ...f, api_key: e.target.value }))}
                            placeholder={llmEditIdx !== -1 ? t("settings.apiKeyKeep") : t("settings.apiKeyNew")}
                          />
                          <button type="button" className="codez-settings-key-toggle" onClick={() => setLlmShowKey((v) => !v)}>
                            {llmShowKey ? t("common.hide") : t("common.show")}
                          </button>
                        </div>
                      </div>
                      {(llmEditForm.provider === "custom" ||
                        llmEditForm.provider === "qwen" ||
                        llmEditForm.provider === "deepseek") && (
                        <div className="codez-settings-field codez-llm-span-2">
                          <label>{t("settings.baseUrl")}</label>
                          <input
                            value={llmEditForm.base_url}
                            onChange={(e) => setLlmEditForm((f) => ({ ...f, base_url: e.target.value }))}
                          />
                        </div>
                      )}
                      <div className="codez-settings-field">
                        <label>{t("settings.llmProviderMaxTokens")}</label>
                        <input
                          type="number"
                          min={0}
                          value={llmEditForm.max_tokens}
                          onChange={(e) =>
                            setLlmEditForm((f) => ({ ...f, max_tokens: Number(e.target.value) || 0 }))
                          }
                        />
                      </div>
                    </div>
                    <div className="codez-llm-provider-form-actions">
                      <button
                        type="button"
                        className="codez-settings-save"
                        onClick={() => {
                          const id = llmEditForm.id.trim();
                          const model = llmEditForm.model.trim();
                          if (!id || !model) return;
                          if (llmEditIdx === -1) {
                            if (form.llm_providers.some((p) => p.id === id)) return;
                            update("llm_providers", [...form.llm_providers, { ...llmEditForm, id, model }]);
                          } else {
                            update(
                              "llm_providers",
                              form.llm_providers.map((p, i) =>
                                i === llmEditIdx ? { ...llmEditForm, id, model } : p,
                              ),
                            );
                          }
                          setLlmEditIdx(null);
                        }}
                      >
                        {t("common.save")}
                      </button>
                      <button type="button" className="codez-settings-cancel" onClick={() => setLlmEditIdx(null)}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="codez-llm-add"
                    onClick={() => {
                      setLlmEditIdx(-1);
                      setLlmEditForm(EMPTY_LLM_PROVIDER);
                      setLlmShowKey(false);
                    }}
                  >
                    + {t("settings.llmProviderAdd")}
                  </button>
                )}
              </section>

              <section className="codez-settings-section">
                <h3>{t("settings.mcpServers")}</h3>
                <p className="codez-settings-hint">{t("settings.mcpServersHint")}</p>

                {form.mcp_servers.map((srv, idx) => (
                  <div key={idx} className="codez-mcp-server">
                    <div className="codez-mcp-server-head">
                      <input
                        className="codez-mcp-name"
                        value={srv.name}
                        onChange={(e) => updateMcp(idx, { name: e.target.value })}
                        placeholder={t("settings.mcpName")}
                      />
                      <select
                        value={srv.transport}
                        onChange={(e) => updateMcp(idx, { transport: e.target.value })}
                      >
                        <option value="stdio">stdio</option>
                        <option value="sse">sse</option>
                      </select>
                      <label className="codez-settings-checkbox">
                        <input
                          type="checkbox"
                          checked={srv.enabled}
                          onChange={(e) => updateMcp(idx, { enabled: e.target.checked })}
                        />
                        {t("settings.mcpEnabled")}
                      </label>
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          update(
                            "mcp_servers",
                            form.mcp_servers.filter((_, i) => i !== idx),
                          )
                        }
                      >
                        {t("chat.delete")}
                      </button>
                    </div>
                    {srv.transport === "sse" ? (
                      <div className="codez-settings-field">
                        <label>{t("settings.mcpUrl")}</label>
                        <input
                          value={srv.url}
                          onChange={(e) => updateMcp(idx, { url: e.target.value })}
                          placeholder="http://localhost:3000"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="codez-settings-field">
                          <label>{t("settings.mcpCommand")}</label>
                          <input
                            value={srv.command}
                            onChange={(e) => updateMcp(idx, { command: e.target.value })}
                            placeholder="npx"
                          />
                        </div>
                        <div className="codez-settings-field">
                          <label>{t("settings.mcpArgs")}</label>
                          <input
                            value={srv.args.join(" ")}
                            onChange={(e) =>
                              updateMcp(idx, {
                                args: e.target.value.split(/\s+/).filter(Boolean),
                              })
                            }
                            placeholder="-y @modelcontextprotocol/server-filesystem /path"
                          />
                        </div>
                      </>
                    )}
                    <div className="codez-settings-field">
                      <label>{t("settings.mcpEnv")}</label>
                      <textarea
                        rows={2}
                        value={Object.entries(srv.env)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("\n")}
                        onChange={(e) => updateMcp(idx, { env: parseEnv(e.target.value) })}
                        placeholder={"KEY=value\nOTHER=value"}
                      />
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  className="codez-llm-add"
                  onClick={() => update("mcp_servers", [...form.mcp_servers, { ...EMPTY_MCP_SERVER }])}
                >
                  + {t("settings.mcpServerAdd")}
                </button>
              </section>
            </div>

            <div className="codez-settings-footer">
              <button type="button" className="codez-settings-cancel" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="codez-settings-save"
                onClick={() => void handleSave()}
                disabled={busy}
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
