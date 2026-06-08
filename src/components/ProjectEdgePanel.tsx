import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectEdge } from "../contexts/ProjectEdgeContext";
import { buildArtifactTree, type ArtifactNode } from "../workspaces/workz/artifactPaths";
import EdgeBookmarkDrawer from "./EdgeBookmarkDrawer";
import "./ProjectEdgePanel.css";

function ArtifactTreeItem({
  node,
  depth,
  activePath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: ArtifactNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const pad = 8 + depth * 12;

  if (node.isDir) {
    return (
      <li className="agentz-edge-artifacts-dir">
        <button
          type="button"
          className="agentz-edge-artifacts-dir-btn"
          style={{ paddingLeft: pad }}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          <span className="agentz-edge-artifacts-chevron">{isOpen ? "▾" : "▸"}</span>
          <span>{node.name}</span>
        </button>
        {isOpen && node.children && node.children.length > 0 && (
          <ul className="agentz-edge-artifacts-children">
            {node.children.map((child) => (
              <ArtifactTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`agentz-edge-artifacts-item${activePath === node.path ? " active" : ""}`}
        style={{ paddingLeft: pad }}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        {node.name}
      </button>
    </li>
  );
}

interface ProjectEdgePanelProps {
  projectDir: string | null;
  onRefreshGit?: () => void;
  onUndoReview?: () => Promise<void>;
  undoing?: boolean;
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
  } = useProjectEdge();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts]);
  const hasChanges = gitChanges.length > 0 || pendingReview != null;
  const changesTop = 8;
  const artifactsTop = hasChanges ? 44 : 8;

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!previewPath) return;
    const parts = previewPath.split("/").filter(Boolean);
    if (parts.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc);
      }
      return next;
    });
  }, [previewPath]);

  if (!projectDir) return null;

  return (
    <div className="agentz-project-edge-panel" aria-label={t("agent.changes")}>
      <EdgeBookmarkDrawer
        label={t("agent.changes")}
        count={gitChanges.length}
        top={changesTop}
        pinned={pendingReview != null}
        hidden={!hasChanges}
      >
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
        {gitChanges.length === 0 ? (
          <div className="agentz-edge-empty">{t("agent.noChanges")}</div>
        ) : (
          <ul className="agentz-edge-changes-list">
            {gitChanges.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="agentz-edge-change"
                  onClick={() => onSelectPath(c.path)}
                >
                  <span className={`agentz-edge-change-badge ${c.status}`}>
                    {c.status.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="agentz-edge-change-path">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {pendingReview && pendingReview.changes.length > 0 && (
          <ul className="agentz-edge-changes-list journal">
            {pendingReview.changes.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="agentz-edge-change"
                  onClick={() => onSelectPath(c.rel_path)}
                >
                  <span className={`agentz-edge-change-badge ${c.existed ? "edit" : "new"}`}>
                    {c.existed ? "M" : "A"}
                  </span>
                  <span className="agentz-edge-change-path">{c.rel_path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </EdgeBookmarkDrawer>

      <EdgeBookmarkDrawer
        label={t("agent.artifacts")}
        count={artifacts.length}
        top={artifactsTop}
        pinned={previewPath != null}
        hidden={artifacts.length === 0}
      >
        <ul className="agentz-edge-artifacts-list">
          {tree.map((node) => (
            <ArtifactTreeItem
              key={node.path}
              node={node}
              depth={0}
              activePath={previewPath}
              expanded={expanded}
              onToggle={toggleDir}
              onSelect={onSelectPath}
            />
          ))}
        </ul>
      </EdgeBookmarkDrawer>
    </div>
  );
}
