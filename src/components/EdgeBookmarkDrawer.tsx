import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface EdgeBookmarkDrawerProps {
  /** Short label shown in the drawer header (the tab itself no longer displays text). */
  label: string;
  count: number;
  top: number;
  pinned?: boolean;
  hidden?: boolean;
  children: ReactNode;
  /** Called when the user clicks the explicit close button. */
  onClose?: () => void;
}

/**
 * Right-edge hover tab that slides open a drawer.
 *
 * The tab is now a compact number badge — no label text — so it never overlaps
 * title-bar controls. A close button appears inside the drawer header when
 * `pinned` is true so users can dismiss it explicitly.
 */
export default function EdgeBookmarkDrawer({
  label,
  count,
  top,
  pinned = false,
  hidden = false,
  children,
  onClose,
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

  const handleClose = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

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
      <div className="agentz-edge-badge" title={label}>
        <span className="agentz-edge-badge-count">{count}</span>
      </div>
      <div className="agentz-edge-drawer">
        <div className="agentz-edge-drawer-head">
          <span>{label}</span>
          {pinned && (
            <button
              type="button"
              className="agentz-edge-drawer-close"
              onClick={handleClose}
              title="Close"
            >
              ✕
            </button>
          )}
        </div>
        <div className="agentz-edge-drawer-body">{children}</div>
      </div>
    </div>
  );
}
