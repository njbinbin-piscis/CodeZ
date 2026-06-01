import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ArtifactsDrawerProps {
  artifacts: string[];
  activePath: string | null;
  pinned: boolean;
  onSelect: (path: string) => void;
}

export default function ArtifactsDrawer({
  artifacts,
  activePath,
  pinned,
  onSelect,
}: ArtifactsDrawerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  if (artifacts.length === 0) return null;

  return (
    <div
      ref={zoneRef}
      className={`codez-artifacts-zone${open ? " open" : ""}${pinned ? " pinned" : ""}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <div className="codez-artifacts-tab" title={t("agent.artifacts")}>
        <span className="codez-artifacts-tab-label">{t("agent.artifacts")}</span>
        <span className="codez-artifacts-tab-count">{artifacts.length}</span>
      </div>
      <div className="codez-artifacts-drawer">
        <div className="codez-artifacts-drawer-head">{t("agent.artifacts")}</div>
        <ul className="codez-artifacts-list">
          {artifacts.map((path) => (
            <li key={path}>
              <button
                type="button"
                className={`codez-artifacts-item${activePath === path ? " active" : ""}`}
                onClick={() => onSelect(path)}
                title={path}
              >
                {path.split("/").pop() ?? path}
                <span className="codez-artifacts-item-path">{path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
