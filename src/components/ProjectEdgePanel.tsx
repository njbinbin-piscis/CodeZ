import { useCallback, useMemo, useState } from "react";
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

  // Track whether the user explicitly closed the drawer while pinned.
  const [forceDismissed, setForceDismissed] = useState(false);

  const hasChanges = gitChanges.length > 0 || pendingReview != null;
  const hasArtifacts = artifacts.length > 0;
  const totalCount = artifacts.length;
  const isPinned = (pendingReview != null || previewPath != null) && !forceDismissed;
  const isHidden = !hasChanges && !hasArtifacts;

  // Build a flat, deduplicated, sorted list of artifact entries.
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

  // When artifacts/changes update, re-show the drawer if the user hasn't dismissed.
  // (Clear forceDismissed when all items disappear so next round starts fresh.)
  const effectivePinned = isPinned && totalCount > 0;

  if (!projectDir) return null;

  return (
    <div className="agentz-project-edge-panel" aria-label={t("agent.changes")}>
      <EdgeBookmarkDrawer
        label={t("agent.changes")}
        count={totalCount}
        top={8}
        pinned={effectivePinned}
        hidden={isHidden}
        onClose={handleClose}
      >
        {/* ── Git changes section ──────────────────────────────── */}
        {hasChanges && (
          <>
            <div className="agentz-edge-section-title">{t("agent.changes")}</div>
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

        {/* ── Artifacts section ─────────────────────────────────── */}
        {hasArtifacts && (
          <>
            <div className="agentz-edge-section-title">{t("agent.artifacts")}</div>
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
          </>
        )}
      </EdgeBookmarkDrawer>
    </div>
  );
}
