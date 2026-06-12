import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectEdge } from "../contexts/ProjectEdgeContext";
import EdgeBookmarkDrawer from "./EdgeBookmarkDrawer";
import "./ProjectEdgePanel.css";

interface ProjectEdgePanelProps {
  projectDir: string | null;
  onRefreshGit?: () => void;
  onUndoReview?: () => Promise<void>;
  undoing?: boolean;
}

type EdgeTabId = "changes" | "artifacts";

/** Extract the bare filename from a path (last segment). */
function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export default function ProjectEdgePanel({
  projectDir,
  onRefreshGit,
  onUndoReview,
  undoing = false,
}: ProjectEdgePanelProps) {
  const { t } = useTranslation();
  const {
    gitChanges,
    artifacts,
    pendingReview,
    previewPath,
    onSelectPath,
    setPendingReview,
    setPreviewPath,
  } = useProjectEdge();

  const [activeTab, setActiveTab] = useState<EdgeTabId>("changes");
  const [forceDismissed, setForceDismissed] = useState(false);

  const hasChanges = gitChanges.length > 0 || pendingReview != null;
  const hasArtifacts = artifacts.length > 0;

  const changesCount = useMemo(() => {
    const paths = new Set<string>();
    for (const c of gitChanges) paths.add(c.path);
    for (const c of pendingReview?.changes ?? []) paths.add(c.rel_path);
    return paths.size;
  }, [gitChanges, pendingReview]);

  const artifactsCount = artifacts.length;

  const badgeCount = useMemo(() => {
    const paths = new Set<string>();
    for (const c of gitChanges) paths.add(c.path);
    for (const c of pendingReview?.changes ?? []) paths.add(c.rel_path);
    for (const p of artifacts) paths.add(p);
    return paths.size;
  }, [gitChanges, pendingReview, artifacts]);

  const isPinned = pendingReview != null && !forceDismissed;
  const isHidden = !hasChanges && !hasArtifacts;

  const flatArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const list: { path: string; name: string }[] = [];
    for (const p of artifacts) {
      if (seen.has(p)) continue;
      seen.add(p);
      list.push({ path: p, name: basename(p) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return list;
  }, [artifacts]);

  const handleClose = useCallback(() => {
    setForceDismissed(true);
    setPreviewPath(null);
  }, [setPreviewPath]);

  useEffect(() => {
    if (!pendingReview && !hasChanges && !hasArtifacts) {
      setForceDismissed(false);
    }
  }, [pendingReview, hasChanges, hasArtifacts]);

  useEffect(() => {
    if (pendingReview) setActiveTab("changes");
  }, [pendingReview]);

  // If the changes tab has nothing to show but artifacts exist, land on artifacts.
  useEffect(() => {
    if (activeTab === "changes" && !hasChanges && hasArtifacts) {
      setActiveTab("artifacts");
    }
  }, [activeTab, hasChanges, hasArtifacts]);

  if (!projectDir) return null;

  const changesLabel = t("agent.changes");
  const artifactsLabel = t("agent.artifacts");
  const badgeTitle = `${changesLabel} (${changesCount}) · ${artifactsLabel} (${artifactsCount})`;

  return (
    <div className="agentz-project-edge-panel" aria-label={badgeTitle}>
      <EdgeBookmarkDrawer
        badgeTitle={badgeTitle}
        count={badgeCount}
        top={8}
        pinned={isPinned}
        hidden={isHidden}
        onClose={handleClose}
        closeLabel={t("common.close")}
        tabs={[
          { id: "changes", label: changesLabel, count: changesCount },
          { id: "artifacts", label: artifactsLabel, count: artifactsCount },
        ]}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as EdgeTabId)}
      >
        {activeTab === "changes" && (
          <>
            {pendingReview && (
              <div className="agentz-edge-review">
                <span className="agentz-edge-review-title">
                  {t("chat.reviewChanges", { count: pendingReview.changes.length })}
                </span>
                <div className="agentz-edge-review-actions">
                  <button
                    type="button"
                    className="agentz-edge-review-btn danger"
                    disabled={undoing}
                    onClick={() => void onUndoReview?.()}
                  >
                    {undoing ? t("chat.undoing") : t("chat.undoAll")}
                  </button>
                  <button
                    type="button"
                    className="agentz-edge-review-btn"
                    disabled={undoing}
                    onClick={() => setPendingReview(null)}
                  >
                    {t("chat.keepAll")}
                  </button>
                </div>
              </div>
            )}
            <div className="agentz-edge-changes-toolbar">
              <button
                type="button"
                className="agentz-edge-refresh"
                onClick={() => onRefreshGit?.()}
                title={t("agent.refreshGit")}
              >
                ⟳
              </button>
            </div>
            {gitChanges.length > 0 ? (
              <ul className="agentz-edge-changes-list">
                {gitChanges.map((c) => (
                  <li key={c.path}>
                    <button
                      type="button"
                      className="agentz-edge-change"
                      onClick={() => onSelectPath(c.path)}
                      title={c.path}
                    >
                      <span className={`agentz-edge-change-badge ${c.status}`}>
                        {c.status.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="agentz-edge-change-path">{basename(c.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="agentz-edge-empty">{t("agent.noChanges")}</div>
            )}
            {pendingReview && pendingReview.changes.length > 0 && (
              <ul className="agentz-edge-changes-list journal">
                {pendingReview.changes.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="agentz-edge-change"
                      onClick={() => onSelectPath(c.rel_path)}
                      title={c.rel_path}
                    >
                      <span className={`agentz-edge-change-badge ${c.existed ? "edit" : "new"}`}>
                        {c.existed ? "M" : "A"}
                      </span>
                      <span className="agentz-edge-change-path">{basename(c.rel_path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {activeTab === "artifacts" && (
          <>
            {flatArtifacts.length > 0 ? (
              <ul className="agentz-edge-artifacts-flat">
                {flatArtifacts.map((a) => (
                  <li key={a.path}>
                    <button
                      type="button"
                      className={`agentz-edge-artifact-item${previewPath === a.path ? " active" : ""}`}
                      onClick={() => onSelectPath(a.path)}
                      title={a.path}
                    >
                      <span className="agentz-edge-artifact-name">{a.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="agentz-edge-empty">{t("agent.noArtifacts")}</div>
            )}
          </>
        )}
      </EdgeBookmarkDrawer>
    </div>
  );
}
