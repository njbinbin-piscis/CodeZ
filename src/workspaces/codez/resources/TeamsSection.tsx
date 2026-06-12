import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import DropdownSelect from "../../../components/DropdownSelect";
import { listAgents, type AgentInfo } from "../../../services/tauri/agents";
import {
  listTeams,
  getTeam,
  saveTeam,
  uninstallTeam,
  type TeamInfo,
  type TeamManifest,
} from "../../../services/tauri/teams";
import { onSettingsRefresh } from "../../../services/settingsRefresh";
import { emptyGraph, validateGraph } from "../../../services/tauri/workflow";
import WorkflowDesigner from "../settings/WorkflowDesigner";
import "../settings/StudioTab.css";

const WORKFLOWS = ["waves", "sequential", "review"] as const;

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

interface TeamsSectionProps {
  view: "installed" | "compose";
  editId?: string | null;
  onEditDone?: () => void;
  onWideLayout?: (wide: boolean) => void;
}

export default function TeamsSection({ view, editId, onEditDone, onWideLayout }: TeamsSectionProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [teamForm, setTeamForm] = useState<TeamManifest | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, tm] = await Promise.all([listAgents(), listTeams()]);
      setAgents(a);
      setTeams(tm);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onSettingsRefresh(() => void refresh());
  }, [refresh]);

  const workflowEditing =
    teamForm != null && (teamForm.mode ?? "swarm") === "workflow";

  useEffect(() => {
    onWideLayout?.(workflowEditing);
    return () => onWideLayout?.(false);
  }, [workflowEditing, onWideLayout]);

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
      onEditDone?.();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [teamForm, refresh, onEditDone]);

  useEffect(() => {
    if (view !== "compose") {
      setTeamForm(null);
      return;
    }
    if (editId === "__new__") {
      setTeamForm({ ...EMPTY_TEAM, org_spec: ORG_SPEC_TEMPLATE });
      setCreating(true);
      return;
    }
    if (editId) void editTeam(editId);
  }, [view, editId, editTeam]);

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

  const showForm = view === "compose" || teamForm != null;

  return (
    <div className="agentz-studio">
      {error && <div className="agentz-settings-error">{error}</div>}

      {!showForm && (
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

      {showForm && teamForm && (
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
              <DropdownSelect
                variant="field"
                value={teamForm.mode ?? "swarm"}
                onChange={(v) =>
                  setTeamForm({
                    ...teamForm,
                    mode: v as "swarm" | "workflow",
                    workflow: v === "workflow" ? teamForm.workflow ?? emptyGraph() : teamForm.workflow,
                  })
                }
                options={[
                  { id: "swarm", label: t("workflow.modeSwarm") },
                  { id: "workflow", label: t("workflow.modeWorkflow") },
                ]}
              />
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
                <DropdownSelect
                  variant="field"
                  value={teamForm.workflow_hint ?? "waves"}
                  options={WORKFLOWS.map((w) => ({ id: w, label: w }))}
                  onChange={(v) => setTeamForm({ ...teamForm, workflow_hint: v })}
                />
                <p className="agentz-settings-hint">{t("studio.workflowHintHelp")}</p>
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
            <button
              type="button"
              className="agentz-settings-cancel"
              onClick={() => {
                setTeamForm(null);
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
