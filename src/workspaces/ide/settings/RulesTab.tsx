import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteRule,
  listRules,
  readRule,
  setRuleEnabled,
  writeRule,
  type RuleFile,
} from "../../../services/tauri/workbench";

interface RulesTabProps {
  projectDir: string | null;
}

interface Editing {
  /** Original filename, or null for a new rule. */
  original: string | null;
  name: string;
  content: string;
}

/** Settings tab: manage Cursor-style project rules under `.codez/rules`. */
export default function RulesTab({ projectDir }: RulesTabProps) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectDir) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRules(await listRules(projectDir));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openEditor = useCallback(
    async (rule?: RuleFile) => {
      if (!projectDir) return;
      if (!rule) {
        setEditing({ original: null, name: "", content: "" });
        return;
      }
      setError(null);
      try {
        const content = await readRule(projectDir, rule.name);
        setEditing({ original: rule.name, name: rule.name, content });
      } catch (e) {
        setError(String(e));
      }
    },
    [projectDir],
  );

  const save = useCallback(async () => {
    if (!projectDir || !editing) return;
    if (!editing.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await writeRule(projectDir, editing.name.trim(), editing.content);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, editing, refresh]);

  const remove = useCallback(
    async (name: string) => {
      if (!projectDir) return;
      setBusy(true);
      setError(null);
      try {
        await deleteRule(projectDir, name);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectDir, refresh],
  );

  const toggle = useCallback(
    async (rule: RuleFile) => {
      if (!projectDir) return;
      setBusy(true);
      setError(null);
      try {
        await setRuleEnabled(projectDir, rule.name, !rule.enabled);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectDir, refresh],
  );

  if (!projectDir) {
    return (
      <div className="codez-settings-tabpanel">
        <div className="codez-wb-empty">{t("workbench.noProject")}</div>
      </div>
    );
  }

  return (
    <div className="codez-settings-tabpanel">
      <section className="codez-settings-section">
        <h3>{t("rules.title")}</h3>
        <p className="codez-settings-hint">{t("rules.hint")}</p>
        {error && <div className="codez-settings-error">{error}</div>}

        {editing ? (
          <div className="codez-wb-editor">
            <div className="codez-settings-field">
              <label>{t("rules.name")}</label>
              <input
                value={editing.name}
                disabled={editing.original !== null}
                onChange={(e) => setEditing((p) => (p ? { ...p, name: e.target.value } : p))}
                placeholder="coding-style.md"
              />
            </div>
            <div className="codez-settings-field">
              <label>{t("rules.content")}</label>
              <textarea
                rows={12}
                value={editing.content}
                onChange={(e) => setEditing((p) => (p ? { ...p, content: e.target.value } : p))}
                placeholder={t("rules.contentPlaceholder")}
              />
            </div>
            <div className="codez-wb-editor-actions">
              <button type="button" className="codez-settings-save" disabled={busy} onClick={() => void save()}>
                {busy ? t("common.saving") : t("common.save")}
              </button>
              <button type="button" className="codez-settings-cancel" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {loading ? (
              <div className="codez-settings-loading">{t("settings.loading")}</div>
            ) : rules.length === 0 ? (
              <div className="codez-wb-empty">{t("rules.empty")}</div>
            ) : (
              <div className="codez-wb-list">
                {rules.map((r) => (
                  <div key={r.name} className="codez-wb-row">
                    <div className="codez-wb-info">
                      <strong>{r.name.replace(/\.disabled$/, "")}</strong>
                      <span className="codez-wb-meta">
                        {r.enabled ? t("rules.enabled") : t("rules.disabled")} · {r.size} B
                      </span>
                    </div>
                    <div className="codez-wb-actions">
                      <button type="button" disabled={busy} onClick={() => void toggle(r)}>
                        {r.enabled ? t("rules.disable") : t("rules.enable")}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void openEditor(r)}>
                        {t("common.edit")}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => void remove(r.name)}
                      >
                        {t("chat.delete")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="codez-llm-add" onClick={() => void openEditor()}>
              + {t("rules.add")}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
