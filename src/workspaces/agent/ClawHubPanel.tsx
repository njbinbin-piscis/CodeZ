import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { clawHubApi, type ClawHubSkill } from "../../services/tauri/clawhub";
import "./ClawHubPanel.css";

interface ClawHubPanelProps {
  onClose: () => void;
}

export default function ClawHubPanel({ onClose }: ClawHubPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ClawHubSkill[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const search = useCallback(async (q?: string) => {
    setSearching(true);
    setError(null);
    try {
      const res = await clawHubApi.search(q ?? query, 24);
      setItems(res.items);
    } catch (e) {
      setError(String(e));
      setItems([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await clawHubApi.search("", 24);
        if (!cancelled) setItems(res.items);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setItems([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async (skill: ClawHubSkill) => {
    setInstalling(skill.slug);
    setError(null);
    setSuccess(null);
    try {
      const res = await clawHubApi.install(skill.slug, skill.version || undefined);
      setSuccess(t("clawhub.installSuccess", { name: res.name }));
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="codez-clawhub-overlay" onClick={onClose}>
      <div className="codez-clawhub-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codez-clawhub-head">
          <h2>{t("clawhub.title")}</h2>
          <button type="button" className="codez-clawhub-close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="codez-clawhub-hint">{t("clawhub.hint")}</p>
        <div className="codez-clawhub-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("clawhub.searchPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <button type="button" onClick={() => void search()} disabled={searching}>
            {searching ? t("clawhub.searching") : t("clawhub.search")}
          </button>
        </div>
        {error && <div className="codez-clawhub-error">{error}</div>}
        {success && <div className="codez-clawhub-success">{success}</div>}
        <div className="codez-clawhub-list">
          {items.length === 0 && !searching && (
            <div className="codez-clawhub-empty">{t("clawhub.empty")}</div>
          )}
          {items.map((skill) => (
            <div key={skill.slug} className="codez-clawhub-card">
              <div className="codez-clawhub-card-main">
                <div className="codez-clawhub-card-title">{skill.name}</div>
                <div className="codez-clawhub-card-slug">{skill.slug}</div>
                {skill.description && (
                  <div className="codez-clawhub-card-desc">{skill.description}</div>
                )}
              </div>
              <button
                type="button"
                className="codez-clawhub-install"
                disabled={installing === skill.slug}
                onClick={() => void install(skill)}
              >
                {installing === skill.slug ? t("clawhub.installing") : t("clawhub.install")}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
