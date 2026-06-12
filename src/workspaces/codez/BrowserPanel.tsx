import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserClickAt,
  browserClose,
  browserCurrentUrl,
  browserInspectAt,
  browserNavigate,
  browserPickAt,
  browserScreenshot,
  browserScrollBy,
  browserScrollInfo,
  browserScrollTo,
  browserSetViewport,
  browserState,
  onBrowserChanged,
  type PickedElement,
  type ScrollInfo,
} from "../../services/tauri/browser";
import "./BrowserPanel.css";

const EMPTY_SCROLL: ScrollInfo = {
  scroll_x: 0,
  scroll_y: 0,
  scroll_width: 0,
  scroll_height: 0,
  client_width: 0,
  client_height: 0,
};

interface BrowserPanelProps {
  onClose: () => void;
  onSendElementToChat: (el: PickedElement) => void;
  onScreenshotToChat: (base64: string) => void;
  /** When false, hide send-to-chat actions (requires an open project folder). */
  chatEnabled?: boolean;
  /** Increment to force refresh after agent browser actions. */
  refreshSignal?: number;
  /** Latest agent browser action label (from chat tool_start). */
  agentAction?: string | null;
  /** Ask parent to confirm before closing (returns true to proceed). */
  onRequestClose?: () => Promise<boolean>;
}

function rectStyle(el: PickedElement, img: HTMLImageElement): React.CSSProperties | null {
  const rw = el.rect_width ?? 0;
  const rh = el.rect_height ?? 0;
  if (!rw || !rh || !img.naturalWidth) return null;
  const sx = img.clientWidth / img.naturalWidth;
  const sy = img.clientHeight / img.naturalHeight;
  return {
    left: (el.rect_x ?? 0) * sx,
    top: (el.rect_y ?? 0) * sy,
    width: rw * sx,
    height: rh * sy,
  };
}

/**
 * Embedded browser: viewport tracks the panel size 1:1, devtools-style hover
 * highlight in pick mode, Cursor-style inspector sidebar, agent-shared CDP page.
 */
export default function BrowserPanel({
  onClose,
  onSendElementToChat,
  onScreenshotToChat,
  chatEnabled = true,
  refreshSignal = 0,
  agentAction = null,
  onRequestClose,
}: BrowserPanelProps) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [hovered, setHovered] = useState<PickedElement | null>(null);
  const [selected, setSelected] = useState<PickedElement | null>(null);
  const [scroll, setScroll] = useState<ScrollInfo>(EMPTY_SCROLL);
  const [pageZoom, setPageZoom] = useState(1);
  const scrollRef = useRef<ScrollInfo>(EMPTY_SCROLL);
  scrollRef.current = scroll;

  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportReady = useRef(false);
  // Accumulated wheel deltas, flushed to the page on a short timer so a burst
  // of wheel events becomes one scroll + one screenshot refresh.
  const wheelAccum = useRef({ dx: 0, dy: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshShot = useCallback(async () => {
    try {
      const b64 = await browserScreenshot();
      setShot(b64);
      setError(null);
    } catch {
      // Browser not launched yet — ignore until first navigate.
    }
  }, []);

  const refreshScrollInfo = useCallback(async () => {
    try {
      setScroll(await browserScrollInfo());
    } catch {
      // Page not ready yet.
    }
  }, []);

  const flushWheel = useCallback(async () => {
    const { dx, dy } = wheelAccum.current;
    wheelAccum.current = { dx: 0, dy: 0 };
    if (dx === 0 && dy === 0) return;
    try {
      const info = await browserScrollBy(dx, dy);
      setScroll(info);
      await refreshShot();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshShot]);
  const flushWheelRef = useRef(flushWheel);
  flushWheelRef.current = flushWheel;
  const pickModeRef = useRef(pickMode);
  pickModeRef.current = pickMode;

  const measureViewport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    // clientWidth/Height = the painted box (excludes scrollbar gutter).
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    const si = scrollRef.current;
    if (si.scroll_height > si.client_height + 1) w = Math.max(0, w - 12);
    if (si.scroll_width > si.client_width + 1) h = Math.max(0, h - 12);
    w = Math.max(320, w);
    h = Math.max(200, h);
    if (w < 8 || h < 8) return null;
    return { w, h };
  }, []);

  const syncViewport = useCallback(async () => {
    const dims = measureViewport();
    if (!dims) return;
    const { w, h } = dims;
    try {
      await browserSetViewport(w, h);
      viewportReady.current = true;
      await refreshShot();
      await refreshScrollInfo();
    } catch (e) {
      if (viewportReady.current) setError(String(e));
    }
  }, [measureViewport, refreshShot, refreshScrollInfo]);

  const syncAddressFromBackend = useCallback(async () => {
    try {
      const st = await browserState();
      if (st.url) setAddress(st.url);
    } catch {
      try {
        const url = await browserCurrentUrl();
        if (url) setAddress(url);
      } catch {
        /* browser not launched */
      }
    }
  }, []);

  useEffect(() => {
    void syncAddressFromBackend();
    let unlisten: (() => void) | undefined;
    void onBrowserChanged(() => {
      void refreshShot();
      void syncAddressFromBackend();
      void refreshScrollInfo();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshShot, refreshScrollInfo, syncAddressFromBackend]);

  useEffect(() => {
    if (refreshSignal > 0) {
      void refreshShot();
      void syncAddressFromBackend();
    }
  }, [refreshSignal, refreshShot, syncAddressFromBackend]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!canvas && !view) return;

    // Wait two frames so flex layout (sidebar, chat panel) has settled before
    // the first measurement — avoids a transient wide width that relayouts the page.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => void syncViewport());
    });

    const onResize = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => void syncViewport(), 120);
    };
    const ro = new ResizeObserver(onResize);
    if (canvas) ro.observe(canvas);
    if (view && view !== canvas) ro.observe(view);
    window.addEventListener("resize", onResize);

    pollRef.current = setInterval(() => {
      if (viewportReady.current) void refreshShot();
    }, 1200);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = null;
    };
  }, [syncViewport, refreshShot]);

  // Native, non-passive wheel listener so we can preventDefault and forward the
  // delta to the page (React's synthetic onWheel is passive — can't cancel).
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setPageZoom((z) => {
          const next = Math.round((z + delta) * 10) / 10;
          return Math.min(2, Math.max(0.5, next));
        });
        return;
      }
      if (pickModeRef.current) return;
      e.preventDefault();
      wheelAccum.current.dx += e.deltaX;
      wheelAccum.current.dy += e.deltaY;
      if (wheelTimer.current) return;
      wheelTimer.current = setTimeout(() => {
        wheelTimer.current = null;
        void flushWheelRef.current();
      }, 40);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "0") return;
      e.preventDefault();
      setPageZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Inspector sidebar steals horizontal space — re-sync viewport after layout.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void syncViewport();
    });
    return () => cancelAnimationFrame(id);
  }, [selected, syncViewport]);

  const navigate = useCallback(async () => {
    const url = address.trim();
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      await syncViewport();
      const finalUrl = await browserNavigate(url);
      setAddress(finalUrl || url);
      await syncViewport();
      await refreshShot();
      await refreshScrollInfo();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [address, refreshShot, refreshScrollInfo, syncViewport]);

  const toPageCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * img.naturalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * img.naturalHeight;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const scrollTo = useCallback(
    async (x: number, y: number) => {
      try {
        const info = await browserScrollTo(x, y);
        setScroll(info);
        await refreshShot();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshShot],
  );

  // Drag a synthetic scrollbar thumb. Maps the pointer position within the
  // track to an absolute page scroll offset, throttled to one call per frame.
  const startScrollDrag = useCallback(
    (axis: "x" | "y") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const track = e.currentTarget.parentElement;
      if (!track) return;
      track.setPointerCapture?.(e.pointerId);

      let raf = 0;
      let pending: { x: number; y: number } | null = null;
      const flush = () => {
        raf = 0;
        if (pending) {
          void scrollTo(pending.x, pending.y);
          pending = null;
        }
      };
      const move = (ev: PointerEvent) => {
        const rect = track.getBoundingClientRect();
        const info = scrollRef.current;
        if (axis === "y") {
          const frac = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
          const max = Math.max(0, info.scroll_height - info.client_height);
          pending = { x: info.scroll_x, y: frac * max };
        } else {
          const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
          const max = Math.max(0, info.scroll_width - info.client_width);
          pending = { x: frac * max, y: info.scroll_y };
        }
        if (!raf) raf = requestAnimationFrame(flush);
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        track.releasePointerCapture?.(ev.pointerId);
        if (raf) cancelAnimationFrame(raf);
        flush();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      move(e.nativeEvent);
    },
    [scrollTo],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!pickMode) return;
      const pt = toPageCoords(e);
      if (!pt) return;
      if (inspectTimer.current) clearTimeout(inspectTimer.current);
      inspectTimer.current = setTimeout(() => {
        void browserInspectAt(pt.x, pt.y)
          .then((el) => setHovered(el))
          .catch(() => setHovered(null));
      }, 60);
    },
    [pickMode],
  );

  const handleMouseLeave = useCallback(() => {
    if (inspectTimer.current) clearTimeout(inspectTimer.current);
    setHovered(null);
  }, []);

  const handleCanvasClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const pt = toPageCoords(e);
      if (!pt) return;
      try {
        if (pickMode) {
          const el = await browserPickAt(pt.x, pt.y);
          if (el) setSelected(el);
        } else {
          await browserClickAt(pt.x, pt.y);
          setTimeout(() => {
            void refreshShot();
            void refreshScrollInfo();
          }, 350);
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [pickMode, refreshShot, refreshScrollInfo],
  );

  const screenshotToChat = useCallback(async () => {
    try {
      const b64 = await browserScreenshot();
      onScreenshotToChat(b64);
    } catch (e) {
      setError(String(e));
    }
  }, [onScreenshotToChat]);

  const close = useCallback(() => {
    void (async () => {
      if (onRequestClose) {
        const ok = await onRequestClose();
        if (!ok) return;
      }
      void browserClose().catch(() => {});
      setPickMode(false);
      setHovered(null);
      setSelected(null);
      onClose();
    })();
  }, [onClose, onRequestClose]);

  const togglePick = () => {
    setPickMode((v) => {
      if (v) {
        setHovered(null);
      } else {
        setSelected(null);
      }
      return !v;
    });
  };

  const hoverBox = hovered && imgRef.current ? rectStyle(hovered, imgRef.current) : null;
  const selectBox = selected && imgRef.current ? rectStyle(selected, imgRef.current) : null;

  // Synthetic scrollbar geometry (screenshot view has no native scrollbar).
  const MIN_THUMB = 24;
  const showVScroll = scroll.scroll_height > scroll.client_height + 1 && scroll.client_height > 0;
  const showHScroll = scroll.scroll_width > scroll.client_width + 1 && scroll.client_width > 0;
  const vThumb = showVScroll
    ? {
        height: `max(${MIN_THUMB}px, ${(scroll.client_height / scroll.scroll_height) * 100}%)`,
        top: `${(scroll.scroll_y / scroll.scroll_height) * 100}%`,
      }
    : null;
  const hThumb = showHScroll
    ? {
        width: `max(${MIN_THUMB}px, ${(scroll.client_width / scroll.scroll_width) * 100}%)`,
        left: `${(scroll.scroll_x / scroll.scroll_width) * 100}%`,
      }
    : null;

  return (
    <div className="agentz-browser">
      <div className="agentz-browser-toolbar">
        <button
          className="agentz-browser-btn"
          onClick={() => void syncViewport().then(refreshShot)}
          title={t("browser.reload")}
        >
          ⟳
        </button>
        <input
          className="agentz-browser-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate();
          }}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
        />
        {agentAction ? (
          <span className="agentz-browser-agent-badge" title={agentAction}>
            {t("browser.agentAction", { action: agentAction })}
          </span>
        ) : null}
        <button
          className={`agentz-browser-btn${pickMode ? " active" : ""}`}
          onClick={togglePick}
          title={t("browser.pickElement")}
        >
          ⌖
        </button>
        <button
          className="agentz-browser-btn"
          onClick={() => void screenshotToChat()}
          disabled={!chatEnabled}
          title={chatEnabled ? t("browser.screenshotToChat") : t("browser.needsProject")}
        >
          ⎙
        </button>
        <button
          className="agentz-browser-btn"
          onClick={() => setPageZoom(1)}
          title={t("browser.zoomReset")}
        >
          {t("browser.zoomLevel", { percent: Math.round(pageZoom * 100) })}
        </button>
        <button className="agentz-browser-btn" onClick={close} title={t("browser.close")}>
          ✕
        </button>
      </div>

      {error && <div className="agentz-browser-error">{error}</div>}
      {pickMode && <div className="agentz-browser-pickhint">{t("browser.pickHint")}</div>}

      <div className="agentz-browser-body">
        <div className="agentz-browser-view" ref={viewRef}>
          <div
            className="agentz-browser-canvas"
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => void handleCanvasClick(e)}
          >
            {loading && (
              <div className="agentz-browser-loading-overlay">{t("browser.loading")}</div>
            )}
            {shot ? (
              <>
                <img
                  ref={imgRef}
                  className={`agentz-browser-shot${pickMode ? " pick" : ""}`}
                  src={`data:image/png;base64,${shot}`}
                  alt="page"
                  draggable={false}
                  style={{
                    ...(scroll.client_width > 0
                      ? { width: scroll.client_width, height: scroll.client_height }
                      : {}),
                    ...(pageZoom !== 1
                      ? { transform: `scale(${pageZoom})`, transformOrigin: "top left" }
                      : {}),
                  }}
                />
                {pickMode && hoverBox && (
                  <div className="agentz-browser-highlight hover" style={hoverBox} />
                )}
                {selectBox && (
                  <div className="agentz-browser-highlight selected" style={selectBox} />
                )}
              </>
            ) : (
              <div className="agentz-browser-empty">{t("browser.empty")}</div>
            )}
          </div>

          {vThumb && (
            <div className="agentz-browser-scrollbar vertical">
              <div
                className="agentz-browser-scrollthumb"
                style={vThumb}
                onPointerDown={startScrollDrag("y")}
              />
            </div>
          )}
          {hThumb && (
            <div className="agentz-browser-scrollbar horizontal">
              <div
                className="agentz-browser-scrollthumb"
                style={hThumb}
                onPointerDown={startScrollDrag("x")}
              />
            </div>
          )}
        </div>

        {selected && (
          <aside className="agentz-browser-inspector">
            <div className="agentz-browser-inspector-head">
              <span>{t("browser.inspector")}</span>
              <button type="button" className="agentz-browser-inspector-close" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div className="agentz-browser-inspector-body">
              <div className="agentz-browser-inspector-row">
                <span className="label">{t("browser.component")}</span>
                <code>
                  {selected.tag}
                  {selected.id ? `#${selected.id}` : ""}
                </code>
              </div>
              {selected.react_component ? (
                <div className="agentz-browser-inspector-row">
                  <span className="label">{t("browser.reactComponent")}</span>
                  <code>{selected.react_component}</code>
                </div>
              ) : null}
              {selected.dom_path ? (
                <div className="agentz-browser-inspector-row stack">
                  <span className="label">{t("browser.domPath")}</span>
                  <pre>{selected.dom_path}</pre>
                </div>
              ) : null}
              <div className="agentz-browser-inspector-row">
                <span className="label">{t("browser.selector")}</span>
                <code>{selected.selector}</code>
              </div>
              {selected.class_name ? (
                <div className="agentz-browser-inspector-row">
                  <span className="label">{t("browser.classes")}</span>
                  <code>{selected.class_name}</code>
                </div>
              ) : null}
              <div className="agentz-browser-inspector-row">
                <span className="label">{t("browser.dimensions")}</span>
                <code>
                  {Math.round(selected.rect_width ?? 0)} × {Math.round(selected.rect_height ?? 0)} px
                </code>
              </div>
              {selected.text ? (
                <div className="agentz-browser-inspector-row stack">
                  <span className="label">{t("browser.text")}</span>
                  <pre>{selected.text}</pre>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="agentz-browser-inspector-send"
              onClick={() => onSendElementToChat(selected)}
              disabled={!chatEnabled}
              title={chatEnabled ? undefined : t("browser.needsProject")}
            >
              {t("browser.sendToChat")}
            </button>
          </aside>
        )}
      </div>
    </div>
  );
}
