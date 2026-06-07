import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import DropdownSelect from "../../../components/DropdownSelect";
import {
  getHooks,
  runHook,
  saveHooks,
  type HookDef,
  type HookEvent,
  type HookRunResult,
  type HooksConfig,
} from "../../../services/tauri/workbench";

interface HooksTabProps {
  projectDir: string | null;
}

const EVENTS: HookEvent[] = [
  "beforeAgentTurn",
  "afterAgentTurn",
  "beforeFileEdit",
  "afterFileEdit",
];

function newHook(): HookDef {
  return {
    id: `hook-${Date.now().toString(36)}`,
    name: "",
    event: "beforeAgentTurn",
    command: "",
    enabled: true,
  };
}

/** Settings tab: manage Cursor-style hooks in `.agentz/hooks.json`. */
export default function HooksTab({ projectDir }: HooksTabProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<HooksConfig>({ version: 1, hooks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [runResult, setRunResult] = useState<Record<string, HookRunResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectDir) {
        setLoading(false);
        return;
      }
      try {
        const c = await getHooks(projectDir);
        if (!cancelled) setConfig(c);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const patch = useCallback((idx: number, p: Partial<HookDef>) => {
    setConfig((prev) => ({
      ...prev,
      hooks: prev.hooks.map((h, i) => (i === idx ? { ...h, ...p } : h)),
    }));
    setDirty(true);
  }, []);

  const add = useCallback(() => {
    setConfig((prev) => ({ ...prev, hooks: [...prev.hooks, newHook()] }));
    setDirty(true);
  }, []);

  const remove = useCallback((idx: number) => {
    setConfig((prev) => ({ ...prev, hooks: prev.hooks.filter((_, i) => i !== idx) }));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!projectDir) return;
    setBusy(true);
    setError(null);
    try {
      await saveHooks(projectDir, config);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, config]);

  const test = useCallback(
    async (hook: HookDef) => {
      if (!projectDir || !hook.command.trim()) return;
      setRunningId(hook.id);
      try {
        const res = await runHook(projectDir, hook.command);
        setRunResult((prev) => ({ ...prev, [hook.id]: res }));
      } catch (e) {
        setRunResult((prev) => ({
          ...prev,
          [hook.id]: { exit_code: -1, stdout: "", stderr: String(e) },
        }));
      } finally {
        setRunningId(null);
      }
    },
    [projectDir],
  );

  if (!projectDir) {
    return (
      <div className="agentz-settings-tabpanel">
        <div className="agentz-wb-empty">{t("workbench.noProject")}</div>
      </div>
    );
  }

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>{t("hooks.title")}</h3>
        <p className="agentz-settings-hint">{t("hooks.hint")}</p>
        {error && <div className="agentz-settings-error">{error}</div>}

        {loading ? (
          <div className="agentz-settings-loading">{t("settings.loading")}</div>
        ) : (
          <>
            {config.hooks.length === 0 && <div className="agentz-wb-empty">{t("hooks.empty")}</div>}
            {config.hooks.map((h, idx) => (
              <div key={h.id} className="agentz-wb-hook">
                <div className="agentz-wb-hook-head">
                  <input
                    className="agentz-mcp-name"
                    value={h.name}
                    onChange={(e) => patch(idx, { name: e.target.value })}
                    placeholder={t("hooks.namePlaceholder")}
                  />
                  <DropdownSelect
                    variant="inline"
                    value={h.event}
                    options={EVENTS.map((ev) => ({ id: ev, label: t(`hooks.event.${ev}`) }))}
                    onChange={(v) => patch(idx, { event: v as HookEvent })}
                  />
                  <label className="agentz-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={h.enabled}
                      onChange={(e) => patch(idx, { enabled: e.target.checked })}
                    />
                    {t("hooks.enabledLabel")}
                  </label>
                  <button type="button" className="danger" onClick={() => remove(idx)}>
                    {t("chat.delete")}
                  </button>
                </div>
                <div className="agentz-settings-field">
                  <label>{t("hooks.command")}</label>
                  <textarea
                    rows={2}
                    value={h.command}
                    onChange={(e) => patch(idx, { command: e.target.value })}
                    placeholder={t("hooks.commandPlaceholder")}
                  />
                </div>
                <div className="agentz-wb-hook-actions">
                  <button
                    type="button"
                    disabled={runningId === h.id || !h.command.trim()}
                    onClick={() => void test(h)}
                  >
                    {runningId === h.id ? t("hooks.running") : t("hooks.test")}
                  </button>
                </div>
                {runResult[h.id] && (
                  <pre className="agentz-wb-hook-output">
                    {`exit=${runResult[h.id].exit_code}\n`}
                    {runResult[h.id].stdout}
                    {runResult[h.id].stderr ? `\n[stderr]\n${runResult[h.id].stderr}` : ""}
                  </pre>
                )}
              </div>
            ))}

            <div className="agentz-wb-hook-footer">
              <button type="button" className="agentz-llm-add" onClick={add}>
                + {t("hooks.add")}
              </button>
              <button
                type="button"
                className="agentz-settings-save"
                disabled={busy || !dirty}
                onClick={() => void save()}
              >
                {busy ? t("common.saving") : t("hooks.saveConfig")}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
