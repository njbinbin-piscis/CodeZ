import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import TagMultiSelect from "../../../components/TagMultiSelect";
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
import {
  listTeams,
  getTeam,
  saveTeam,
  uninstallTeam,
  type TeamInfo,
  type TeamManifest,
} from "../../../services/tauri/teams";
import { listInstalledSkills, type InstalledSkill } from "../../../services/tauri/workbench";
import { listConnectors, type ConnectorInfo } from "../../../services/tauri/connectors";
import { getSettings, type SettingsResponse } from "../../../services/tauri/settings";
import { emptyGraph, validateGraph } from "../../../services/tauri/workflow";
import WorkflowDesigner from "./WorkflowDesigner";
import "./StudioTab.css";

const ICON_CHOICES = ["🐙", "🦑", "🐬", "🦈", "🐳", "🐟", "🦞", "🤖", "📊", "🎨", "💻", "🔬", "📝", "🛡️", "🧠", "⚡", "🔧", "🎯", "🏗️"];
const WORKFLOWS = ["waves", "sequential", "review"] as const;

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

const EMPTY_TEAM: TeamManifest = {
  id: "",
  name: "",
  description: "",
  mode: "swarm",
  org_spec: "",
  members: [],
  workflow_hint: "waves",
  workflow: null,
  task_timeout_secs: 0,
};

const ORG_SPEC_TEMPLATE = `# Project Goal\n\n<what this team is trying to accomplish>\n\n# Roles\n\n- <agent>: <responsibility>\n\n# Collaboration Rules\n\n- Coordinate through the shared todo board.\n- Hand off work with clear, self-contained briefs.\n\n# Integration Model\n\n- <how work is merged / reviewed>\n`;

interface StudioTabProps {
  /** Notify parent to widen the settings panel (workflow designer needs ~80vw). */
  onWideLayout?: (wide: boolean) => void;
}

export default function StudioTab({ onWideLayout }: StudioTabProps) {
  const { t } = useTranslation();
  const [sub, setSub] = useState<"agents" | "teams">("agents");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [builtinTools, setBuiltinTools] = useState<BuiltinToolInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [agentForm, setAgentForm] = useState<AgentManifest | null>(null);
  const [teamForm, setTeamForm] = useState<TeamManifest | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, tm, sk, bt, cn, st] = await Promise.all([
        listAgents(),
        listTeams(),
        listInstalledSkills(),
        listBuiltinTools(),
        listConnectors(),
        getSettings(),
      ]);
      setAgents(a);
      setTeams(tm);
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
  }, [refresh]);

  const workflowEditing =
    sub === "teams" && teamForm != null && (teamForm.mode ?? "swarm") === "workflow";

  useEffect(() => {
    onWideLayout?.(workflowEditing);
    return () => onWideLayout?.(false);
  }, [workflowEditing, onWideLayout]);

  const mcpNames = useMemo(
    () => (settings?.mcp_servers ?? []).map((s) => s.name).filter(Boolean),
    [settings],
  );
  const providers = settings?.llm_providers ?? [];

  const skillOptions = useMemo(
    () =>
      skills.map((s) => ({
        value: s.slug,
        label: s.name || s.slug,
        hint: s.description || s.slug,
      })),
    [skills],
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

  const newAgent = useCallback(() => {
    setAgentForm({ ...EMPTY_AGENT });
    setCreating(true);
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
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [agentForm, refresh]);

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

  // ── Team editing ─────────────────────────────────────────────────────────
  const editTeam = useCallback(async (id: string) => {
    try {
      const m = await getTeam(id);
      setTeamForm({ ...EMPTY_TEAM, ...m });
      setCreating(false);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const newTeam = useCallback(() => {
    setTeamForm({ ...EMPTY_TEAM, org_spec: ORG_SPEC_TEMPLATE });
    setCreating(true);
  }, []);

  const submitTeam = useCallback(async () => {
    if (!teamForm) return;
    setError(null);
    try {
      // Workflow teams derive their member set from the agents used in the
      // graph, so the membership checkboxes are swarm-only.
      const members =
        (teamForm.mode ?? "swarm") === "workflow"
          ? Array.from(
              new Set(
                (teamForm.workflow?.nodes ?? [])
                  .filter((n) => n.type === "agent" && n.agent_id)
                  .map((n) => n.agent_id as string),
              ),
            )
          : teamForm.members;
      await saveTeam({
        ...teamForm,
        members,
        id: teamForm.id.trim(),
        name: teamForm.name.trim() || teamForm.id.trim(),
      });
      setTeamForm(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [teamForm, refresh]);

  const removeTeam = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await uninstallTeam(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const toggleInList = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="agentz-studio">
      {error && <div className="agentz-settings-error">{error}</div>}

      <div className="agentz-studio-subtabs">
        <button
          type="button"
          className={sub === "agents" ? "active" : ""}
          onClick={() => setSub("agents")}
        >
          {t("studio.agents")}
        </button>
        <button
          type="button"
          className={sub === "teams" ? "active" : ""}
          onClick={() => setSub("teams")}
        >
          {t("studio.teams")}
        </button>
      </div>

      {sub === "agents" && !agentForm && (
        <div className="agentz-studio-list">
          <div className="agentz-studio-list-head">
            <span>{t("studio.agentsHint")}</span>
            <button type="button" className="agentz-settings-save" onClick={newAgent}>
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
                <button type="button" onClick={() => void editAgent(a.id)}>
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

      {sub === "agents" && agentForm && (
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
              <select
                value={agentForm.llm_provider_id ?? ""}
                onChange={(e) =>
                  setAgentForm({ ...agentForm, llm_provider_id: e.target.value || null })
                }
              >
                <option value="">{t("studio.modelDefault")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
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
            <button type="button" className="agentz-settings-cancel" onClick={() => setAgentForm(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {sub === "teams" && !teamForm && (
        <div className="agentz-studio-list">
          <div className="agentz-studio-list-head">
            <span>{t("studio.teamsHint")}</span>
            <button type="button" className="agentz-settings-save" onClick={newTeam}>
              + {t("studio.newTeam")}
            </button>
          </div>
          {teams.length === 0 && <p className="agentz-settings-hint">{t("studio.noTeams")}</p>}
          {teams.map((tm) => (
            <div key={tm.id} className="agentz-studio-card">
              <div className="agentz-studio-card-icon" style={{ background: "#4ecdc4" }}>
                👥
              </div>
              <div className="agentz-studio-card-body">
                <strong>{tm.name}</strong>
                <span className="agentz-studio-card-meta">
                  {tm.mode === "workflow" ? t("workflow.modeWorkflow") : t("workflow.modeSwarm")} ·{" "}
                  {tm.members.length} {t("studio.members")}
                </span>
              </div>
              <div className="agentz-studio-card-actions">
                <button type="button" onClick={() => void editTeam(tm.id)}>
                  {t("common.edit")}
                </button>
                <button type="button" className="danger" onClick={() => void removeTeam(tm.id)}>
                  {t("chat.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sub === "teams" && teamForm && (
        <div
          className={`agentz-studio-form ${(teamForm.mode ?? "swarm") === "workflow" ? "agentz-studio-form--full" : ""}`}
        >
          <div className="agentz-studio-grid">
            <div className="agentz-settings-field">
              <label>{t("studio.fieldId")}</label>
              <input
                value={teamForm.id}
                disabled={!creating}
                onChange={(e) => setTeamForm({ ...teamForm, id: e.target.value })}
                placeholder="fullstack-squad"
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("studio.fieldName")}</label>
              <input
                value={teamForm.name}
                onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })}
              />
            </div>
            <div className="agentz-settings-field">
              <label>{t("workflow.fieldMode")}</label>
              <select
                value={teamForm.mode ?? "swarm"}
                onChange={(e) =>
                  setTeamForm({
                    ...teamForm,
                    mode: e.target.value as "swarm" | "workflow",
                    workflow:
                      e.target.value === "workflow"
                        ? teamForm.workflow ?? emptyGraph()
                        : teamForm.workflow,
                  })
                }
              >
                <option value="swarm">{t("workflow.modeSwarm")}</option>
                <option value="workflow">{t("workflow.modeWorkflow")}</option>
              </select>
            </div>
          </div>

          <div className="agentz-settings-field">
            <label>{t("studio.fieldDescription")}</label>
            <input
              value={teamForm.description ?? ""}
              onChange={(e) => setTeamForm({ ...teamForm, description: e.target.value })}
            />
          </div>

          {(teamForm.mode ?? "swarm") === "swarm" && (
            <div className="agentz-settings-field">
              <label>{t("studio.fieldMembers")}</label>
              <div className="agentz-studio-checks">
                {agents.length === 0 && <span className="agentz-settings-hint">{t("studio.noAgents")}</span>}
                {agents.map((a) => (
                  <label key={a.id} className="agentz-studio-check">
                    <input
                      type="checkbox"
                      checked={(teamForm.members ?? []).includes(a.id)}
                      onChange={() =>
                        setTeamForm({ ...teamForm, members: toggleInList(teamForm.members ?? [], a.id) })
                      }
                    />
                    {a.icon} {a.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {(teamForm.mode ?? "swarm") === "swarm" ? (
            <>
              <div className="agentz-settings-field">
                <label>{t("studio.fieldWorkflow")}</label>
                <select
                  value={teamForm.workflow_hint ?? "waves"}
                  onChange={(e) => setTeamForm({ ...teamForm, workflow_hint: e.target.value })}
                >
                  {WORKFLOWS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
              <div className="agentz-settings-field">
                <label>{t("studio.fieldOrgSpec")}</label>
                <textarea
                  className="agentz-settings-textarea-lg"
                  rows={12}
                  value={teamForm.org_spec ?? ""}
                  onChange={(e) => setTeamForm({ ...teamForm, org_spec: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="agentz-settings-field">
              <label>{t("workflow.designer")}</label>
              {(() => {
                const issues = validateGraph(teamForm.workflow ?? emptyGraph());
                return issues.length > 0 ? (
                  <div className="agentz-wf-issues">
                    <strong>{t("workflow.issues")}</strong>
                    <ul>
                      {issues.map((iss, i) => (
                        <li key={i}>{iss}</li>
                      ))}
                    </ul>
                  </div>
                ) : null;
              })()}
              <WorkflowDesigner
                graph={teamForm.workflow ?? emptyGraph()}
                agents={agents}
                onChange={(g) => setTeamForm({ ...teamForm, workflow: g })}
              />
            </div>
          )}

          <div className="agentz-studio-form-actions">
            <button
              type="button"
              className="agentz-settings-save"
              disabled={
                !teamForm.id.trim() ||
                ((teamForm.mode ?? "swarm") === "swarm"
                  ? (teamForm.members ?? []).length === 0
                  : validateGraph(teamForm.workflow ?? emptyGraph()).length > 0)
              }
              onClick={() => void submitTeam()}
            >
              {t("common.save")}
            </button>
            <button type="button" className="agentz-settings-cancel" onClick={() => setTeamForm(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
