import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listInstalledSkills,
  uninstallSkill,
  type InstalledSkill,
} from "../../../services/tauri/workbench";
import { clawHubApi, type ClawHubSkill } from "../../../services/tauri/clawhub";

/** Settings tab: manage installed skills + search/install from ClawHub. */
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInstalled(await listInstalledSkills());
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

  return (
    <div className="codez-settings-tabpanel">
      <section className="codez-settings-section">
        <h3>{t("skills.installedTitle")}</h3>
        <p className="codez-settings-hint">{t("skills.installedHint")}</p>
        {error && <div className="codez-settings-error">{error}</div>}
        {loading ? (
          <div className="codez-settings-loading">{t("settings.loading")}</div>
        ) : installed.length === 0 ? (
          <div className="codez-wb-empty">{t("skills.empty")}</div>
        ) : (
          <div className="codez-wb-list">
            {installed.map((s) => (
              <div key={s.slug} className="codez-wb-row">
                <div className="codez-wb-info">
                  <strong>{s.name}</strong>
                  <span className="codez-wb-meta">{s.slug}</span>
                  {s.description && <span className="codez-wb-desc">{s.description}</span>}
                </div>
                <div className="codez-wb-actions">
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

      <section className="codez-settings-section">
        <h3>{t("skills.marketTitle")}</h3>
        <p className="codez-settings-hint">{t("skills.marketHint")}</p>
        <div className="codez-wb-search">
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
        {searchError && <div className="codez-settings-error">{searchError}</div>}
        <div className="codez-wb-list">
          {results.map((r) => {
            const already = installedSlugs.has(r.slug);
            return (
              <div key={r.slug} className="codez-wb-row">
                <div className="codez-wb-info">
                  <strong>{r.name}</strong>
                  <span className="codez-wb-meta">
                    {r.slug}
                    {r.version ? ` · v${r.version}` : ""}
                    {r.stars ? ` · ★${r.stars}` : ""}
                  </span>
                  {r.description && <span className="codez-wb-desc">{r.description}</span>}
                </div>
                <div className="codez-wb-actions">
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
