import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fishIdForSkillSlug, listFish, saveFish, deleteFish, type FishDef } from "../../../services/tauri/fish";
import { listInstalledSkills, type InstalledSkill } from "../../../services/tauri/workbench";

interface FishForm {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
}

const EMPTY_FORM: FishForm = { id: "", name: "", description: "", system_prompt: "" };

export default function AnonymousAgentsView() {
  const { t } = useTranslation();
  const [fish, setFish] = useState<FishDef[]>([]);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<FishForm | null>(null);
  const [isNew, setIsNew] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, s] = await Promise.all([listFish(), listInstalledSkills().catch(() => [])]);
      setFish(f);
      setSkills(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startNew = () => {
    setEditing({ ...EMPTY_FORM });
    setIsNew(true);
  };

  const startEdit = (f: FishDef) => {
    setEditing({
      id: f.id,
      name: f.name,
      description: f.description,
      system_prompt: f.system_prompt,
    });
    setIsNew(false);
  };

  const fromSkill = (s: InstalledSkill) => {
    setEditing({
      id: fishIdForSkillSlug(s.slug),
      name: s.name || s.slug,
      description: s.description || "",
      system_prompt:
        `You are an anonymous agent derived from the "${s.name || s.slug}" skill.\n` +
        `${s.description || ""}\n\n` +
        `Apply this skill to complete the brief and return only the final result.`,
    });
    setIsNew(true);
  };

  const doSave = useCallback(async () => {
    if (!editing) return;
    const id = editing.id.trim();
    const prompt = editing.system_prompt.trim();
    if (!id || !prompt) return;
    setBusy(true);
    setError(null);
    try {
      await saveFish({
        id,
        name: editing.name.trim(),
        description: editing.description.trim(),
        system_prompt: prompt,
      });
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [editing, refresh]);

  const doDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await deleteFish(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>{t("anonymousAgent.title")}</h3>
        <p className="agentz-settings-hint">{t("anonymousAgent.hint")}</p>

        {error && <div className="agentz-settings-error">{error}</div>}
        {loading ? (
          <div className="agentz-settings-loading">{t("settings.loading")}</div>
        ) : (
          <>
            <div className="agentz-fish-list">
              {fish.map((f) => (
                <div key={f.id} className="agentz-fish-row">
                  <div className="agentz-fish-info">
                    <strong>
                      {f.name || f.id}
                      <span className={`agentz-fish-badge ${f.source}`}>
                        {f.source === "builtin"
                          ? t("anonymousAgent.builtin")
                          : t("anonymousAgent.user")}
                      </span>
                    </strong>
                    <span className="agentz-fish-meta">
                      <code>{f.id}</code> · {f.description || "—"}
                    </span>
                  </div>
                  <div className="agentz-fish-actions">
                    <button type="button" onClick={() => startEdit(f)} disabled={busy}>
                      {f.source === "builtin" ? t("anonymousAgent.override") : t("common.edit")}
                    </button>
                    {f.source === "user" && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void doDelete(f.id)}
                        disabled={busy}
                      >
                        {t("chat.delete")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {editing ? (
              <div className="agentz-fish-form">
                <h4>{isNew ? t("anonymousAgent.add") : t("anonymousAgent.edit")}</h4>
                <div className="agentz-settings-field">
                  <label>{t("anonymousAgent.id")}</label>
                  <input
                    value={editing.id}
                    disabled={!isNew}
                    onChange={(e) => setEditing((f) => f && { ...f, id: e.target.value })}
                    placeholder="my-anonymous-agent"
                  />
                </div>
                <div className="agentz-settings-field">
                  <label>{t("anonymousAgent.name")}</label>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing((f) => f && { ...f, name: e.target.value })}
                  />
                </div>
                <div className="agentz-settings-field">
                  <label>{t("anonymousAgent.description")}</label>
                  <input
                    value={editing.description}
                    onChange={(e) =>
                      setEditing((f) => f && { ...f, description: e.target.value })
                    }
                    placeholder={t("anonymousAgent.descriptionPlaceholder")}
                  />
                </div>
                <div className="agentz-settings-field">
                  <label>{t("anonymousAgent.systemPrompt")}</label>
                  <textarea
                    rows={6}
                    value={editing.system_prompt}
                    onChange={(e) =>
                      setEditing((f) => f && { ...f, system_prompt: e.target.value })
                    }
                    placeholder={t("anonymousAgent.systemPromptPlaceholder")}
                  />
                </div>
                <div className="agentz-fish-form-actions">
                  <button
                    type="button"
                    className="agentz-settings-save"
                    onClick={() => void doSave()}
                    disabled={busy || !editing.id.trim() || !editing.system_prompt.trim()}
                  >
                    {busy ? t("common.saving") : t("common.save")}
                  </button>
                  <button
                    type="button"
                    className="agentz-settings-cancel"
                    onClick={() => setEditing(null)}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="agentz-settings-add" onClick={startNew}>
                + {t("anonymousAgent.add")}
              </button>
            )}
          </>
        )}
      </section>

      {!loading && skills.length > 0 && (
        <section className="agentz-settings-section">
          <h3>{t("anonymousAgent.fromSkillTitle")}</h3>
          <p className="agentz-settings-hint">{t("anonymousAgent.fromSkillHint")}</p>
          <div className="agentz-fish-skill-list">
            {skills.map((s) => (
              <div key={s.slug} className="agentz-fish-row">
                <div className="agentz-fish-info">
                  <strong>{s.name || s.slug}</strong>
                  <span className="agentz-fish-meta">{s.description || "—"}</span>
                </div>
                <div className="agentz-fish-actions">
                  <button type="button" onClick={() => fromSkill(s)} disabled={busy}>
                    {t("anonymousAgent.fromSkillAction")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
