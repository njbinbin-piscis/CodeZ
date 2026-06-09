import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface EdgeBookmarkDrawerProps {
  /** Short label shown in the drawer header (the tab itself no longer displays text). */
  label: string;
  count: number;
  top: number;
  /** When true, show a close button that calls `onClose` (e.g. pending review). */
  pinned?: boolean;
  hidden?: boolean;
  children: ReactNode;
  /** Called when the user clicks the explicit close button. */
  onClose?: () => void;
}

/**
 * Right-edge hover tab that slides open a drawer.
 *
 * The tab is a compact number badge so it does not overlap title-bar controls.
 * Hover opens the drawer; mouse leave, click-outside, or list-item click closes it.
 * `pinned` only adds a header close affordance — it does not lock the drawer open.
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

  const close = useCallback(() => {
    clearHideTimer();
    setOpen(false);
  }, [clearHideTimer]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setOpen(false), 280);
  }, [clearHideTimer]);

  const show = useCallback(() => {
    clearHideTimer();
    setOpen(true);
  }, [clearHideTimer]);

  const handleClose = useCallback(() => {
    close();
    onClose?.();
  }, [close, onClose]);

  const handleBodyClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (!target.closest("button")) return;
      close();
    },
    [close],
  );

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = zoneRef.current;
      if (!root || root.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

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
          {(open || pinned) && (
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
        <div className="agentz-edge-drawer-body" onClick={handleBodyClick}>
          {children}
        </div>
      </div>
    </div>
  );
}
