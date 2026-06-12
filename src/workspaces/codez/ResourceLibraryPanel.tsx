import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./SettingsPanel.css";
import "./ResourceLibraryPanel.css";
import {
  LIBRARY_CATEGORIES,
  viewsForCategory,
  type LibraryCategory,
  type LibraryInitialState,
  type LibraryView,
} from "./resources/types";
import SkillsInstalledView from "./resources/SkillsInstalledView";
import SkillsDiscoverView from "./resources/SkillsDiscoverView";
import MarketGridView from "./resources/MarketGridView";
import AgentsSection from "./resources/AgentsSection";
import TeamsSection from "./resources/TeamsSection";
import ConnectorsInstalledView from "./resources/ConnectorsInstalledView";
import ConnectorsDiscoverView from "./resources/ConnectorsDiscoverView";
import AnonymousAgentsView from "./resources/AnonymousAgentsView";

export type { LibraryInitialState };

interface ResourceLibraryPanelProps {
  onClose: () => void;
  initial?: LibraryInitialState | null;
}

export default function ResourceLibraryPanel({ onClose, initial }: ResourceLibraryPanelProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<LibraryCategory>(initial?.category ?? "skill");
  const [view, setView] = useState<LibraryView>(initial?.view ?? "installed");
  const [composeEditId, setComposeEditId] = useState<string | null>(initial?.editId ?? null);
  const [expandConnectorId, setExpandConnectorId] = useState<string | null>(
    initial?.expandConnectorId ?? null,
  );
  const [wide, setWide] = useState(false);

  const availableViews = useMemo(() => viewsForCategory(category), [category]);

  useEffect(() => {
    if (!availableViews.includes(view)) {
      setView(availableViews[0] ?? "installed");
    }
  }, [availableViews, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const switchCategory = useCallback((cat: LibraryCategory) => {
    setCategory(cat);
    const views = viewsForCategory(cat);
    setView(views[0] ?? "installed");
    setComposeEditId(null);
    setExpandConnectorId(null);
    setWide(false);
  }, []);

  const switchView = useCallback((v: LibraryView) => {
    setView(v);
    if (v !== "compose") setComposeEditId(null);
    if (v !== "installed") setExpandConnectorId(null);
  }, []);

  const startCompose = useCallback((id: string | null = "__new__") => {
    setView("compose");
    setComposeEditId(id);
  }, []);

  const handleConnectorInstalled = useCallback((connectorId: string) => {
    setExpandConnectorId(connectorId);
    setView("installed");
  }, []);

  const goDiscover = useCallback(
    (target: "skill" | "connector") => {
      setCategory(target);
      setView("discover");
    },
    [],
  );

  const content = useMemo(() => {
    if (category === "skill") {
      if (view === "discover") return <SkillsDiscoverView />;
      return <SkillsInstalledView />;
    }
    if (category === "tool") {
      return <MarketGridView category="tool" mode={view === "discover" ? "discover" : "installed"} />;
    }
    if (category === "agent") {
      if (view === "discover") {
        return <MarketGridView category="agent" mode="discover" />;
      }
      return (
        <AgentsSection
          view={view === "compose" ? "compose" : "installed"}
          editId={view === "compose" ? composeEditId : null}
          onEditDone={() => {
            setComposeEditId(null);
            if (view === "compose" && composeEditId) setView("installed");
          }}
          onGoDiscover={goDiscover}
        />
      );
    }
    if (category === "team") {
      if (view === "discover") {
        return <MarketGridView category="team" mode="discover" />;
      }
      return (
        <TeamsSection
          view={view === "compose" ? "compose" : "installed"}
          editId={view === "compose" ? composeEditId : null}
          onEditDone={() => {
            setComposeEditId(null);
            if (view === "compose" && composeEditId) setView("installed");
          }}
          onWideLayout={setWide}
        />
      );
    }
    if (category === "connector") {
      if (view === "discover") {
        return <ConnectorsDiscoverView onInstalled={handleConnectorInstalled} />;
      }
      return <ConnectorsInstalledView expandConnectorId={expandConnectorId} />;
    }
    return <AnonymousAgentsView />;
  }, [
    category,
    view,
    composeEditId,
    expandConnectorId,
    goDiscover,
    handleConnectorInstalled,
  ]);

  return (
    <div className="agentz-library-overlay" onClick={onClose}>
      <div
        className={`agentz-library${wide ? " agentz-library--wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agentz-library-head">
          <div>
            <h2>{t("library.title")}</h2>
            <p className="agentz-library-subtitle">{t("library.subtitle")}</p>
          </div>
          <button type="button" className="agentz-library-close" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </div>

        <div className="agentz-library-cats" role="tablist">
          {LIBRARY_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={category === cat}
              className={`agentz-library-cat ${category === cat ? "active" : ""}`}
              onClick={() => switchCategory(cat)}
            >
              {t(`library.cat_${cat}`)}
            </button>
          ))}
        </div>

        {availableViews.length > 1 && (
          <div className="agentz-library-views" role="tablist">
            {availableViews.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={`agentz-library-view ${view === v ? "active" : ""}`}
                onClick={() => switchView(v)}
              >
                {t(`library.view_${v}`)}
              </button>
            ))}
            {view === "compose" && (category === "agent" || category === "team") && (
              <button type="button" className="agentz-library-view" onClick={() => startCompose("__new__")}>
                + {category === "agent" ? t("studio.newAgent") : t("studio.newTeam")}
              </button>
            )}
          </div>
        )}

        <div className="agentz-library-body">
          <div className="agentz-library-view-panel">{content}</div>
        </div>
      </div>
    </div>
  );
}
