import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listInstalledSkills,
  uninstallSkill,
  type InstalledSkill,
} from "../../../services/tauri/workbench";
import { clawHubApi, type ClawHubSkill } from "../../../services/tauri/clawhub";
import {
  skillEvolutionApi,
  type CuratorStatus,
  type SkillEvolutionSettings,
} from "../../../services/tauri/skillEvolution";

/** Settings tab: installed skills, evolution drafts, ClawHub, and Curator. */
export default function SkillsTab() {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClawHubSkill[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [curatorStatus, setCuratorStatus] = useState<CuratorStatus | null>(null);
  const [evoSettings, setEvoSettings] = useState<SkillEvolutionSettings | null>(null);
  const [curatorMsg, setCuratorMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skills, status, settings] = await Promise.all([
        listInstalledSkills(),
        skillEvolutionApi.curatorStatus().catch(() => null),
        skillEvolutionApi.getSettings().catch(() => null),
      ]);
      setInstalled(skills);
      setCuratorStatus(status);
      setEvoSettings(settings);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedSlugs = new Set(installed.map((s) => s.slug));
  const stableSkills = useMemo(
    () => installed.filter((s) => (s.quadrant ?? "installed") === "installed"),
    [installed],
  );
  const evolvingSkills = useMemo(
    () => installed.filter((s) => s.quadrant === "draft" || s.quadrant === "learned"),
    [installed],
  );

  const doUninstall = useCallback(
    async (slug: string) => {
      setBusySlug(slug);
      setError(null);
      try {
        await uninstallSkill(slug);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusySlug(null);
      }
    },
    [refresh],
  );

  const doEvolution = useCallback(
    async (slug: string, action: "promote" | "discard" | "lock" | "unlock") => {
      setBusySlug(slug);
      setError(null);
      try {
        if (action === "promote") await skillEvolutionApi.promote(slug);
        if (action === "discard") await skillEvolutionApi.discard(slug);
        if (action === "lock") await skillEvolutionApi.lock(slug);
        if (action === "unlock") await skillEvolutionApi.unlock(slug);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusySlug(null);
      }
    },
    [refresh],
  );

  const doSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await clawHubApi.search(query, 20);
      setResults(res.items);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, [query]);

  const doInstall = useCallback(
    async (skill: ClawHubSkill) => {
      setBusySlug(skill.slug);
      setSearchError(null);
      try {
        await clawHubApi.install(skill.slug, skill.version);
        await refresh();
      } catch (e) {
        setSearchError(String(e));
      } finally {
        setBusySlug(null);
      }
    },
    [refresh],
  );

  const runCurator = useCallback(async (dryRun: boolean) => {
    setCuratorMsg(null);
    try {
      const msg = await skillEvolutionApi.curatorRun(dryRun);
      setCuratorMsg(msg);
      await refresh();
    } catch (e) {
      setCuratorMsg(String(e));
    }
  }, [refresh]);

  const saveEvoToggle = useCallback(
    async (patch: Partial<SkillEvolutionSettings>) => {
      if (!evoSettings) return;
      const next = { ...evoSettings, ...patch };
      setEvoSettings(next);
      try {
        await skillEvolutionApi.saveSettings(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [evoSettings],
  );

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>{t("skills.installedTitle")}</h3>
        <p className="agentz-settings-hint">{t("skills.installedHint")}</p>
        {error && <div className="agentz-settings-error">{error}</div>}
        {loading ? (
          <div className="agentz-settings-loading">{t("settings.loading")}</div>
        ) : stableSkills.length === 0 ? (
          <div className="agentz-wb-empty">{t("skills.empty")}</div>
        ) : (
          <div className="agentz-wb-list">
            {stableSkills.map((s) => (
              <div key={s.slug} className="agentz-wb-row">
                <div className="agentz-wb-info">
                  <strong>{s.name}</strong>
                  <span className="agentz-wb-meta">{s.slug}</span>
                  {s.description && <span className="agentz-wb-desc">{s.description}</span>}
                </div>
                <div className="agentz-wb-actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={busySlug === s.slug}
                    onClick={() => void doUninstall(s.slug)}
                  >
                    {busySlug === s.slug ? t("common.saving") : t("skills.uninstall")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="agentz-settings-section">
        <h3>{t("skills.evolutionTitle")}</h3>
        <p className="agentz-settings-hint">{t("skills.evolutionHint")}</p>
        {evoSettings && (
          <label className="agentz-settings-row">
            <input
              type="checkbox"
              checked={evoSettings.review_enabled}
              onChange={(e) => void saveEvoToggle({ review_enabled: e.target.checked })}
            />
            {t("skills.reviewEnabled")}
          </label>
        )}
        {evolvingSkills.length === 0 ? (
          <div className="agentz-wb-empty">{t("skills.evolutionEmpty")}</div>
        ) : (
          <div className="agentz-wb-list">
            {evolvingSkills.map((s) => (
              <div key={s.slug} className="agentz-wb-row">
                <div className="agentz-wb-info">
                  <strong>{s.name}</strong>
                  <span className="agentz-wb-meta">
                    {s.slug} · {s.quadrant ?? s.lifecycle}
                    {s.locked ? " · locked" : ""}
                  </span>
                  {s.description && <span className="agentz-wb-desc">{s.description}</span>}
                </div>
                <div className="agentz-wb-actions">
                  {s.quadrant === "draft" && (
                    <button
                      type="button"
                      disabled={busySlug === s.slug}
                      onClick={() => void doEvolution(s.slug, "promote")}
                    >
                      {t("skills.promote")}
                    </button>
                  )}
                  {s.quadrant === "draft" && (
                    <button
                      type="button"
                      className="danger"
                      disabled={busySlug === s.slug}
                      onClick={() => void doEvolution(s.slug, "discard")}
                    >
                      {t("skills.discard")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busySlug === s.slug}
                    onClick={() =>
                      void doEvolution(s.slug, s.locked ? "unlock" : "lock")
                    }
                  >
                    {s.locked ? t("skills.unlock") : t("skills.lock")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="agentz-settings-section">
        <h3>{t("skills.curatorTitle")}</h3>
        <p className="agentz-settings-hint">{t("skills.curatorHint")}</p>
        {curatorStatus && (
          <p className="agentz-wb-meta">
            {t("skills.curatorStats", {
              draft: curatorStatus.draft_count,
              learned: curatorStatus.learned_count,
              archived: curatorStatus.archived_count,
            })}
          </p>
        )}
        <div className="agentz-wb-actions">
          <button type="button" onClick={() => void runCurator(true)}>
            {t("skills.curatorDryRun")}
          </button>
          <button type="button" onClick={() => void runCurator(false)}>
            {t("skills.curatorRun")}
          </button>
        </div>
        {curatorMsg && <p className="agentz-wb-desc">{curatorMsg}</p>}
      </section>

      <section className="agentz-settings-section">
        <h3>{t("skills.marketTitle")}</h3>
        <p className="agentz-settings-hint">{t("skills.marketHint")}</p>
        <div className="agentz-wb-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
            placeholder={t("skills.searchPlaceholder")}
          />
          <button type="button" onClick={() => void doSearch()} disabled={searching}>
            {searching ? t("skills.searching") : t("skills.search")}
          </button>
        </div>
        {searchError && <div className="agentz-settings-error">{searchError}</div>}
        <div className="agentz-wb-list">
          {results.map((r) => {
            const already = installedSlugs.has(r.slug);
            return (
              <div key={r.slug} className="agentz-wb-row">
                <div className="agentz-wb-info">
                  <strong>{r.name}</strong>
                  <span className="agentz-wb-meta">
                    {r.slug}
                    {r.version ? ` · v${r.version}` : ""}
                    {r.stars ? ` · ★${r.stars}` : ""}
                  </span>
                  {r.description && <span className="agentz-wb-desc">{r.description}</span>}
                </div>
                <div className="agentz-wb-actions">
                  <button
                    type="button"
                    disabled={already || busySlug === r.slug}
                    onClick={() => void doInstall(r)}
                  >
                    {already
                      ? t("skills.installed")
                      : busySlug === r.slug
                        ? t("skills.installing")
                        : t("skills.install")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
