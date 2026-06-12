import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface EdgeDrawerTab {
  id: string;
  label: string;
  count: number;
}

interface EdgeBookmarkDrawerProps {
  /** Tooltip on the collapsed badge. */
  badgeTitle: string;
  /** Number shown inside the badge. */
  count: number;
  top: number;
  tabs: EdgeDrawerTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  closeLabel?: string;
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
 * The tab is a compact number badge on the right edge. Chat header actions are
 * inset separately so they do not overlap. Hover opens the drawer; mouse leave,
 * click-outside, or list-item click closes it. `pinned` only adds a close button.
 */
export default function EdgeBookmarkDrawer({
  badgeTitle,
  count,
  top,
  tabs,
  activeTab,
  onTabChange,
  closeLabel = "Close",
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
      <div className="agentz-edge-badge" title={badgeTitle}>
        <span className="agentz-edge-badge-count">{count}</span>
      </div>
      <div className="agentz-edge-drawer">
        <div className="agentz-edge-drawer-head">
          <div className="agentz-edge-drawer-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTab}
                className={`agentz-edge-drawer-tab${tab.id === activeTab ? " active" : ""}`}
                onClick={() => onTabChange(tab.id)}
              >
                <span>{tab.label}</span>
                {tab.count > 0 && <span className="agentz-edge-drawer-tab-count">{tab.count}</span>}
              </button>
            ))}
          </div>
          {(open || pinned) && (
            <button
              type="button"
              className="agentz-edge-drawer-close"
              onClick={handleClose}
              title={closeLabel}
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
