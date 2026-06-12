import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  marketplaceSearch,
  marketplaceInstall,
  marketplaceUninstall,
  type MarketCategory,
  type MarketItem,
} from "../../../services/tauri/marketplace";

const SEARCHABLE: Set<MarketCategory> = new Set(["skill"]);
const LOCAL_INSTALL: Set<MarketCategory> = new Set(["tool", "agent", "team", "connector"]);

interface MarketGridViewProps {
  category: MarketCategory;
  mode: "installed" | "discover";
  onInstalled?: (item: MarketItem) => void;
}

/** Marketplace grid for tool / agent / team / connector (and skill discover). */
export default function MarketGridView({ category, mode, onInstalled }: MarketGridViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localSource, setLocalSource] = useState("");

  const search = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        setItems(await marketplaceSearch(category, q));
      } catch (e) {
        setError(String(e));
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [category],
  );

  useEffect(() => {
    void search("");
    setQuery("");
    setNotice(null);
  }, [category, search]);

  const visibleItems =
    mode === "installed" ? items.filter((i) => i.installed) : items.filter((i) => !i.installed);

  const install = useCallback(
    async (item: MarketItem) => {
      setBusyId(item.id);
      setError(null);
      setNotice(null);
      try {
        await marketplaceInstall(item.category, item.source, item.id, item.version || null);
        setNotice(t("library.installedNotice", { name: item.name }));
        onInstalled?.(item);
        await search(query);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [query, search, onInstalled, t],
  );

  const uninstall = useCallback(
    async (item: MarketItem) => {
      setBusyId(item.id);
      setError(null);
      try {
        await marketplaceUninstall(item.category, item.id);
        await search(query);
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
      setNotice(t("library.installedGeneric"));
      setLocalSource("");
      await search(query);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [category, localSource, query, search, t]);

  return (
    <div className="agentz-library-view">
      {mode === "discover" && SEARCHABLE.has(category) && (
        <div className="agentz-market-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("library.searchPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && void search(query)}
          />
          <button type="button" onClick={() => void search(query)} disabled={loading}>
            {loading ? t("library.searching") : t("library.search")}
          </button>
        </div>
      )}

      {mode === "discover" && LOCAL_INSTALL.has(category) && (
        <div className="agentz-market-search">
          <input
            value={localSource}
            onChange={(e) => setLocalSource(e.target.value)}
            placeholder={t("library.localPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && void installLocal()}
          />
          <button type="button" onClick={() => void installLocal()} disabled={busyId === "__local__"}>
            {busyId === "__local__" ? t("library.installing") : t("library.installLocal")}
          </button>
        </div>
      )}

      {error && <div className="agentz-market-error">{error}</div>}
      {notice && <div className="agentz-market-notice">{notice}</div>}

      <div className="agentz-market-grid">
        {loading && visibleItems.length === 0 ? (
          <div className="agentz-market-empty">{t("library.loading")}</div>
        ) : visibleItems.length === 0 ? (
          <div className="agentz-market-empty">{t("library.empty")}</div>
        ) : (
          visibleItems.map((item) => (
            <div key={`${item.source}:${item.id}`} className="agentz-market-card">
              <div className="agentz-market-card-icon">{item.icon || "📦"}</div>
              <div className="agentz-market-card-body">
                <div className="agentz-market-card-title">
                  {item.name}
                  {item.version && <span className="agentz-market-ver">v{item.version}</span>}
                  {item.stars > 0 && <span className="agentz-market-stars">★{item.stars}</span>}
                </div>
                <div className="agentz-market-card-meta">
                  <span className="agentz-market-src">{item.source}</span>
                  {item.tag && <span className="agentz-market-tag">{item.tag}</span>}
                  {item.category === "connector" && (
                    <span className={`agentz-market-auth ${item.authorized ? "ok" : "no"}`}>
                      {item.authorized ? t("library.authorized") : t("library.unauthorized")}
                    </span>
                  )}
                </div>
                {item.description && <div className="agentz-market-desc">{item.description}</div>}
              </div>
              <div className="agentz-market-card-actions">
                {mode === "installed" || item.installed ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busyId === item.id}
                    onClick={() => void uninstall(item)}
                  >
                    {busyId === item.id ? t("library.working") : t("library.uninstall")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void install(item)}
                  >
                    {busyId === item.id
                      ? t("library.installing")
                      : item.category === "connector"
                        ? t("library.enable")
                        : t("library.install")}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
