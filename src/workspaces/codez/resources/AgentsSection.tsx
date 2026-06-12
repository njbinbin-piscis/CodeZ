import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import TagMultiSelect from "../../../components/TagMultiSelect";
import DropdownSelect from "../../../components/DropdownSelect";
import {
  listAgents,
  getAgent,
  saveAgent,
  uninstallAgent,
  listBuiltinTools,
  type AgentInfo,
  type AgentManifest,
  type BuiltinToolInfo,
} from "../../../services/tauri/agents";
import { listInstalledSkills, type InstalledSkill } from "../../../services/tauri/workbench";
import { listConnectors, type ConnectorInfo } from "../../../services/tauri/connectors";
import { getSettings, type SettingsResponse } from "../../../services/tauri/settings";
import { onSettingsRefresh } from "../../../services/settingsRefresh";
import "../settings/StudioTab.css";

const ICON_CHOICES = ["🐙", "🦑", "🐬", "🦈", "🐳", "🐟", "🦞", "🤖", "📊", "🎨", "💻", "🔬", "📝", "🛡️", "🧠", "⚡", "🔧", "🎯", "🏗️"];
const EMPTY_AGENT: AgentManifest = {
  id: "",
  name: "",
  role: "",
  icon: "🤖",
  color: "#7c6af7",
  description: "",
  system_prompt: "",
  skills: [],
  tools: [],
  mcp_servers: [],
  connectors: [],
  llm_provider_id: null,
  max_iterations: 0,
  task_timeout_secs: 0,
};

interface AgentsSectionProps {
  view: "installed" | "compose";
  editId?: string | null;
  onEditDone?: () => void;
  onGoDiscover?: (target: "skill" | "connector") => void;
}

export default function AgentsSection({ view, editId, onEditDone, onGoDiscover }: AgentsSectionProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [builtinTools, setBuiltinTools] = useState<BuiltinToolInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [agentForm, setAgentForm] = useState<AgentManifest | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, sk, bt, cn, st] = await Promise.all([
        listAgents(),
        listInstalledSkills(),
        listBuiltinTools(),
        listConnectors(),
        getSettings(),
      ]);
      setAgents(a);
      setSkills(sk);
      setBuiltinTools(bt);
      setConnectors(cn);
      setSettings(st);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onSettingsRefresh(() => void refresh());
  }, [refresh]);

  const mcpNames = useMemo(
    () => (settings?.mcp_servers ?? []).map((s) => s.name).filter(Boolean),
    [settings],
  );
  const providers = settings?.llm_providers ?? [];

  const skillOptions = useMemo(
    () =>
      skills.map((s) => {
        const quadrantLabel =
          s.quadrant === "draft"
            ? t("skills.quadrantDraft")
            : s.quadrant === "learned"
              ? t("skills.quadrantLearned")
              : s.quadrant === "installed"
                ? t("skills.quadrantInstalled")
                : null;
        const base = s.name || s.slug;
        return {
          value: s.slug,
          label: quadrantLabel && s.quadrant !== "installed" ? `${base} · ${quadrantLabel}` : base,
          hint: s.description || s.slug,
        };
      }),
    [skills, t],
  );

  const toolOptions = useMemo(
    () =>
      builtinTools.map((tool) => ({
        value: tool.id,
        label: tool.label,
        hint: `${tool.group} · ${tool.hint}`,
      })),
    [builtinTools],
  );

  const mcpOptions = useMemo(
    () => mcpNames.map((name) => ({ value: name, label: name })),
    [mcpNames],
  );

  const connectorOptions = useMemo(
    () =>
      connectors.map((c) => ({
        value: c.id,
        label: `${c.icon ? `${c.icon} ` : ""}${c.name}`,
        hint: [c.category, c.authorized ? undefined : t("studio.connectorUnauthorized"), c.description]
          .filter(Boolean)
          .join(" · "),
      })),
    [connectors, t],
  );

  // ── Agent editing ────────────────────────────────────────────────────────
  const editAgent = useCallback(async (id: string) => {
    try {
      const m = await getAgent(id);
      setAgentForm({ ...EMPTY_AGENT, ...m });
      setCreating(false);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const submitAgent = useCallback(async () => {
    if (!agentForm) return;
    setError(null);
    try {
      await saveAgent({
        ...agentForm,
        id: agentForm.id.trim(),
        name: agentForm.name.trim() || agentForm.id.trim(),
      });
      setAgentForm(null);
      onEditDone?.();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [agentForm, refresh, onEditDone]);

  useEffect(() => {
    if (view !== "compose") {
      setAgentForm(null);
      return;
    }
    if (editId === "__new__") {
      setAgentForm({ ...EMPTY_AGENT });
      setCreating(true);
      return;
    }
    if (editId) void editAgent(editId);
  }, [view, editId, editAgent]);

  const removeAgent = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await uninstallAgent(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const showForm = view === "compose" || agentForm != null;

  return (
    <div className="agentz-studio">
      {error && <div className="agentz-settings-error">{error}</div>}

      {!showForm && (
        <div className="agentz-studio-list">
          <div className="agentz-studio-list-head">
            <span>{t("studio.agentsHint")}</span>
            <button
              type="button"
              className="agentz-settings-save"
              onClick={() => {
                setAgentForm({ ...EMPTY_AGENT });
                setCreating(true);
              }}
            >
              + {t("studio.newAgent")}
            </button>
          </div>
          {agents.length === 0 && <p className="agentz-settings-hint">{t("studio.noAgents")}</p>}
          {agents.map((a) => (
            <div key={a.id} className="agentz-studio-card">
              <div className="agentz-studio-card-icon" style={{ background: a.color || "#7c6af7" }}>
                {a.icon || "🤖"}
              </div>
              <div className="agentz-studio-card-body">
                <strong>{a.name}</strong>
                <span className="agentz-studio-card-meta">{a.role || a.description || a.id}</span>
              </div>
              <div className="agentz-studio-card-actions">
                <button
                  type="button"
                  onClick={() => {
                    void editAgent(a.id);
                  }}
                >
                  {t("common.edit")}
                </button>
                <button type="button" className="danger" onClick={() => void removeAgent(a.id)}>
                  {t("chat.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && agentForm && (
        <div className="agentz-studio-form agentz-studio-form--full">
          <div className="agentz-studio-grid">
            <div className="agentz-settings-field">
              <label>{t("studio.fieldId")}</label>
              <input
                value={agentForm.id}
                disabled={!creating}
                onChange={(e) => setAgentForm({ ...agentForm, id: e.target.value })}
                placeholder="coder"
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("studio.fieldName")}</label>
              <input
                value={agentForm.name}
                onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                placeholder="Coder"
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("studio.fieldRole")}</label>
              <input
                value={agentForm.role ?? ""}
                onChange={(e) => setAgentForm({ ...agentForm, role: e.target.value })}
                placeholder="implementer"
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("studio.fieldModel")}</label>
              <DropdownSelect
                variant="field"
                value={agentForm.llm_provider_id ?? ""}
                options={[
                  { id: "", label: t("studio.modelDefault") },
                  ...providers.map((p) => ({ id: p.id, label: p.label || p.id })),
                ]}
                onChange={(v) => setAgentForm({ ...agentForm, llm_provider_id: v || null })}
              />
              {providers.length === 0 && (
                <p className="agentz-settings-hint">{t("studio.modelProvidersHint")}</p>
              )}
            </div>
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldIcon")}</label>
            <div className="agentz-studio-icons">
              {ICON_CHOICES.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={agentForm.icon === ic ? "active" : ""}
                  onClick={() => setAgentForm({ ...agentForm, icon: ic })}
                >
                  {ic}
                </button>
              ))}
            </div>
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldDescription")}</label>
            <input
              value={agentForm.description ?? ""}
              onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })}
            />
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldSystemPrompt")}</label>
            <textarea
              className="agentz-settings-textarea-lg"
              rows={8}
              value={agentForm.system_prompt ?? ""}
              onChange={(e) => setAgentForm({ ...agentForm, system_prompt: e.target.value })}
              placeholder={t("studio.systemPromptPlaceholder")}
            />
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldSkills")}</label>
            <TagMultiSelect
              values={agentForm.skills ?? []}
              options={skillOptions}
              onChange={(skills) => setAgentForm({ ...agentForm, skills })}
              placeholder={t("studio.skillsSearchPlaceholder")}
              emptyText={skills.length === 0 ? t("chat.skillsEmpty") : t("tagMultiSelect.noMatch")}
            />
            <p className="agentz-settings-hint">{t("studio.skillsPickerHint")}</p>
          </div>

          {mcpNames.length > 0 && (
            <div className="agentz-settings-field">
              <label>{t("studio.fieldMcp")}</label>
              <TagMultiSelect
                values={agentForm.mcp_servers ?? []}
                options={mcpOptions}
                onChange={(mcp_servers) => setAgentForm({ ...agentForm, mcp_servers })}
                placeholder={t("studio.mcpSearchPlaceholder")}
              />
            </div>
          )}

          <div className="agentz-settings-field">
            <label>{t("studio.fieldTools")}</label>
            <TagMultiSelect
              values={agentForm.tools ?? []}
              options={toolOptions}
              onChange={(tools) => setAgentForm({ ...agentForm, tools })}
              placeholder={t("studio.toolsSearchPlaceholder")}
            />
            <p className="agentz-settings-hint">{t("studio.toolsHint")}</p>
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldConnectors")}</label>
            <TagMultiSelect
              values={agentForm.connectors ?? []}
              options={connectorOptions}
              onChange={(connectors) => setAgentForm({ ...agentForm, connectors })}
              placeholder={t("studio.connectorsSearchPlaceholder")}
              emptyText={
                connectors.length === 0 ? t("studio.connectorsEmpty") : t("tagMultiSelect.noMatch")
              }
            />
            <p className="agentz-settings-hint">{t("studio.connectorsHint")}</p>
            {connectors.length === 0 && onGoDiscover && (
              <button type="button" className="agentz-settings-add" onClick={() => onGoDiscover("connector")}>
                {t("library.goDiscoverConnectors")}
              </button>
            )}
          </div>

          <div className="agentz-studio-form-actions">
            <button
              type="button"
              className="agentz-settings-save"
              disabled={!agentForm.id.trim()}
              onClick={() => void submitAgent()}
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="agentz-settings-cancel"
              onClick={() => {
                setAgentForm(null);
                onEditDone?.();
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
