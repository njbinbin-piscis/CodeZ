import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  marketplaceSearch,
  marketplaceInstall,
  marketplaceUninstall,
  type MarketCategory,
  type MarketItem,
} from "../../services/tauri/marketplace";
import "./MarketplacePanel.css";

interface MarketplacePanelProps {
  onClose: () => void;
  initialCategory?: MarketCategory;
}

const CATEGORIES: MarketCategory[] = ["skill", "tool", "agent", "team", "connector"];

/** Categories whose discovery happens through a remote/searchable source. */
const SEARCHABLE: Set<MarketCategory> = new Set(["skill"]);
/** Categories installable from a local path / raw-manifest URL. */
const LOCAL_INSTALL: Set<MarketCategory> = new Set(["tool", "agent", "team", "connector"]);

/**
 * Unified, multi-source marketplace (Phase 4). One surface for discovering and
 * installing every layer of the agent system. Skills come from ClawHub; tools /
 * agents / teams / connectors install from a local path or raw-manifest URL and
 * are listed for management. Replaces the standalone ClawHub panel.
 */
export default function MarketplacePanel({ onClose, initialCategory = "skill" }: MarketplacePanelProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<MarketCategory>(initialCategory);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localSource, setLocalSource] = useState("");

  const search = useCallback(
    async (cat: MarketCategory, q: string) => {
      setLoading(true);
      setError(null);
      try {
        setItems(await marketplaceSearch(cat, q));
      } catch (e) {
        setError(String(e));
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void search(category, "");
    setQuery("");
    setNotice(null);
  }, [category, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const install = useCallback(
    async (item: MarketItem) => {
      setBusyId(item.id);
      setError(null);
      setNotice(null);
      try {
        await marketplaceInstall(item.category, item.source, item.id, item.version || null);
        setNotice(t("market.installed", { name: item.name }));
        await search(category, query);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [category, query, search, t],
  );

  const uninstall = useCallback(
    async (item: MarketItem) => {
      setBusyId(item.id);
      setError(null);
      setNotice(null);
      try {
        await marketplaceUninstall(item.category, item.id);
        await search(category, query);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [category, query, search],
  );

  const installLocal = useCallback(async () => {
    const source = localSource.trim();
    if (!source) return;
    setBusyId("__local__");
    setError(null);
    setNotice(null);
    try {
      await marketplaceInstall(category, "local", source, null);
      setNotice(t("market.installedGeneric"));
      setLocalSource("");
      await search(category, query);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [category, localSource, query, search, t]);

  return (
    <div className="codez-market-overlay" onClick={onClose}>
      <div className="codez-market" onClick={(e) => e.stopPropagation()}>
        <div className="codez-market-head">
          <h2>{t("market.title")}</h2>
          <button type="button" className="codez-market-close" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>

        <div className="codez-market-cats" role="tablist">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={category === cat}
              className={`codez-market-cat ${category === cat ? "active" : ""}`}
              onClick={() => setCategory(cat)}
            >
              {t(`market.cat_${cat}`)}
            </button>
          ))}
        </div>

        {SEARCHABLE.has(category) && (
          <div className="codez-market-search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("market.searchPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && void search(category, query)}
            />
            <button type="button" onClick={() => void search(category, query)} disabled={loading}>
              {loading ? t("market.searching") : t("market.search")}
            </button>
          </div>
        )}

        {LOCAL_INSTALL.has(category) && (
          <div className="codez-market-search">
            <input
              value={localSource}
              onChange={(e) => setLocalSource(e.target.value)}
              placeholder={t("market.localPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && void installLocal()}
            />
            <button type="button" onClick={() => void installLocal()} disabled={busyId === "__local__"}>
              {busyId === "__local__" ? t("market.installing") : t("market.installLocal")}
            </button>
          </div>
        )}

        {error && <div className="codez-market-error">{error}</div>}
        {notice && <div className="codez-market-notice">{notice}</div>}

        <div className="codez-market-grid">
          {loading && items.length === 0 ? (
            <div className="codez-market-empty">{t("market.loading")}</div>
          ) : items.length === 0 ? (
            <div className="codez-market-empty">{t("market.empty")}</div>
          ) : (
            items.map((item) => (
              <div key={`${item.source}:${item.id}`} className="codez-market-card">
                <div className="codez-market-card-icon">{item.icon || "📦"}</div>
                <div className="codez-market-card-body">
                  <div className="codez-market-card-title">
                    {item.name}
                    {item.version && <span className="codez-market-ver">v{item.version}</span>}
                    {item.stars > 0 && <span className="codez-market-stars">★{item.stars}</span>}
                  </div>
                  <div className="codez-market-card-meta">
                    <span className="codez-market-src">{item.source}</span>
                    {item.tag && <span className="codez-market-tag">{item.tag}</span>}
                    {item.category === "connector" && (
                      <span className={`codez-market-auth ${item.authorized ? "ok" : "no"}`}>
                        {item.authorized ? t("market.authorized") : t("market.unauthorized")}
                      </span>
                    )}
                  </div>
                  {item.description && <div className="codez-market-desc">{item.description}</div>}
                </div>
                <div className="codez-market-card-actions">
                  {item.installed ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={busyId === item.id}
                      onClick={() => void uninstall(item)}
                    >
                      {busyId === item.id ? t("market.working") : t("market.uninstall")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === item.id}
                      onClick={() => void install(item)}
                    >
                      {busyId === item.id
                        ? t("market.installing")
                        : item.category === "connector"
                          ? t("market.enable")
                          : t("market.install")}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
