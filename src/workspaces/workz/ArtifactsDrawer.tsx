import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildArtifactTree, type ArtifactNode } from "./artifactPaths";

interface ArtifactsDrawerProps {
  artifacts: string[];
  activePath: string | null;
  pinned: boolean;
  onSelect: (path: string) => void;
}

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
      <li className="agentz-artifacts-dir">
        <button
          type="button"
          className="agentz-artifacts-dir-btn"
          style={{ paddingLeft: pad }}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          <span className="agentz-artifacts-chevron">{isOpen ? "▾" : "▸"}</span>
          <span className="agentz-artifacts-dir-name">{node.name}</span>
        </button>
        {isOpen && node.children && node.children.length > 0 && (
          <ul className="agentz-artifacts-children">
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
        className={`agentz-artifacts-item${activePath === node.path ? " active" : ""}`}
        style={{ paddingLeft: pad }}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        {node.name}
      </button>
    </li>
  );
}

export default function ArtifactsDrawer({
  artifacts,
  activePath,
  pinned,
  onSelect,
}: ArtifactsDrawerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const hideTimer = useRef<number | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts]);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (pinned) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setOpen(false), 280);
  }, [pinned, clearHideTimer]);

  const show = useCallback(() => {
    clearHideTimer();
    setOpen(true);
  }, [clearHideTimer]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  // Expand ancestors of the active preview file.
  useEffect(() => {
    if (!activePath) return;
    const parts = activePath.split("/").filter(Boolean);
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
  }, [activePath]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  if (artifacts.length === 0) return null;

  return (
    <div
      ref={zoneRef}
      className={`agentz-artifacts-zone${open ? " open" : ""}${pinned ? " pinned" : ""}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <div className="agentz-artifacts-tab" title={t("agent.artifacts")}>
        <span className="agentz-artifacts-tab-label">{t("agent.artifacts")}</span>
        <span className="agentz-artifacts-tab-count">{artifacts.length}</span>
      </div>
      <div className="agentz-artifacts-drawer">
        <div className="agentz-artifacts-drawer-head">{t("agent.artifacts")}</div>
        <ul className="agentz-artifacts-list">
          {tree.map((node) => (
            <ArtifactTreeItem
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              expanded={expanded}
              onToggle={toggleDir}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
