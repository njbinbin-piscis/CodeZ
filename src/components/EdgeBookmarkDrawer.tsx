import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface EdgeBookmarkDrawerProps {
  label: string;
  count: number;
  top: number;
  pinned?: boolean;
  hidden?: boolean;
  children: ReactNode;
}

/** Right-edge hover tab that slides open a drawer (shared by Changes / Artifacts). */
export default function EdgeBookmarkDrawer({
  label,
  count,
  top,
  pinned = false,
  hidden = false,
  children,
}: EdgeBookmarkDrawerProps) {
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

  if (hidden) return null;

  return (
    <div
      ref={zoneRef}
      className={`agentz-edge-zone${open ? " open" : ""}${pinned ? " pinned" : ""}`}
      style={{ top }}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <div className="agentz-edge-tab" title={label}>
        <span className="agentz-edge-tab-label">{label}</span>
        {count > 0 && <span className="agentz-edge-tab-count">{count}</span>}
      </div>
      <div className="agentz-edge-drawer">
        <div className="agentz-edge-drawer-head">{label}</div>
        <div className="agentz-edge-drawer-body">{children}</div>
      </div>
    </div>
  );
}
