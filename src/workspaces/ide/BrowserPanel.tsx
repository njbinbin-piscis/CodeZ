import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserClickAt,
  browserClose,
  browserInspectAt,
  browserNavigate,
  browserPickAt,
  browserScreenshot,
  browserSetViewport,
  type PickedElement,
} from "../../services/tauri/browser";
import "./BrowserPanel.css";

interface BrowserPanelProps {
  onClose: () => void;
  onSendElementToChat: (el: PickedElement) => void;
  onScreenshotToChat: (base64: string) => void;
  /** When false, hide send-to-chat actions (requires an open project folder). */
  chatEnabled?: boolean;
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
}: BrowserPanelProps) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [hovered, setHovered] = useState<PickedElement | null>(null);
  const [selected, setSelected] = useState<PickedElement | null>(null);

  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportReady = useRef(false);

  const refreshShot = useCallback(async () => {
    try {
      const b64 = await browserScreenshot();
      setShot(b64);
      setError(null);
    } catch {
      // Browser not launched yet — ignore until first navigate.
    }
  }, []);

  const syncViewport = useCallback(async () => {
    const el = viewRef.current ?? canvasRef.current;
    if (!el) return;
    const w = Math.max(320, Math.round(el.clientWidth));
    const h = Math.max(200, Math.round(el.clientHeight));
    if (w < 8 || h < 8) return;
    try {
      await browserSetViewport(w, h);
      viewportReady.current = true;
      await refreshShot();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshShot]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;

    void syncViewport();

    const ro = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => void syncViewport(), 120);
    });
    ro.observe(el);

    pollRef.current = setInterval(() => {
      if (viewportReady.current) void refreshShot();
    }, 1200);

    return () => {
      ro.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [syncViewport, refreshShot]);

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
      await refreshShot();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [address, refreshShot, syncViewport]);

  const toPageCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * img.naturalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * img.naturalHeight;
    return { x: Math.round(x), y: Math.round(y) };
  };

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
          setTimeout(() => void refreshShot(), 350);
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [pickMode, refreshShot],
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
    void browserClose().catch(() => {});
    setPickMode(false);
    setHovered(null);
    setSelected(null);
    onClose();
  }, [onClose]);

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

  return (
    <div className="codez-browser">
      <div className="codez-browser-toolbar">
        <button
          className="codez-browser-btn"
          onClick={() => void syncViewport().then(refreshShot)}
          title={t("browser.reload")}
        >
          ⟳
        </button>
        <input
          className="codez-browser-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate();
          }}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
        />
        <button
          className={`codez-browser-btn${pickMode ? " active" : ""}`}
          onClick={togglePick}
          title={t("browser.pickElement")}
        >
          ⌖
        </button>
        <button
          className="codez-browser-btn"
          onClick={() => void screenshotToChat()}
          disabled={!chatEnabled}
          title={chatEnabled ? t("browser.screenshotToChat") : t("browser.needsProject")}
        >
          ⎙
        </button>
        <button className="codez-browser-btn" onClick={close} title={t("browser.close")}>
          ✕
        </button>
      </div>

      {error && <div className="codez-browser-error">{error}</div>}
      {pickMode && <div className="codez-browser-pickhint">{t("browser.pickHint")}</div>}

      <div className="codez-browser-body">
        <div className="codez-browser-view" ref={viewRef}>
          <div
            className="codez-browser-canvas"
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => void handleCanvasClick(e)}
          >
            {loading && (
              <div className="codez-browser-loading-overlay">{t("browser.loading")}</div>
            )}
            {shot ? (
              <>
                <img
                  ref={imgRef}
                  className={`codez-browser-shot${pickMode ? " pick" : ""}`}
                  src={`data:image/png;base64,${shot}`}
                  alt="page"
                  draggable={false}
                />
                {pickMode && hoverBox && (
                  <div className="codez-browser-highlight hover" style={hoverBox} />
                )}
                {selectBox && (
                  <div className="codez-browser-highlight selected" style={selectBox} />
                )}
              </>
            ) : (
              <div className="codez-browser-empty">{t("browser.empty")}</div>
            )}
          </div>
        </div>

        {selected && (
          <aside className="codez-browser-inspector">
            <div className="codez-browser-inspector-head">
              <span>{t("browser.inspector")}</span>
              <button type="button" className="codez-browser-inspector-close" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div className="codez-browser-inspector-body">
              <div className="codez-browser-inspector-row">
                <span className="label">{t("browser.component")}</span>
                <code>
                  {selected.tag}
                  {selected.id ? `#${selected.id}` : ""}
                </code>
              </div>
              {selected.react_component ? (
                <div className="codez-browser-inspector-row">
                  <span className="label">{t("browser.reactComponent")}</span>
                  <code>{selected.react_component}</code>
                </div>
              ) : null}
              {selected.dom_path ? (
                <div className="codez-browser-inspector-row stack">
                  <span className="label">{t("browser.domPath")}</span>
                  <pre>{selected.dom_path}</pre>
                </div>
              ) : null}
              <div className="codez-browser-inspector-row">
                <span className="label">{t("browser.selector")}</span>
                <code>{selected.selector}</code>
              </div>
              {selected.class_name ? (
                <div className="codez-browser-inspector-row">
                  <span className="label">{t("browser.classes")}</span>
                  <code>{selected.class_name}</code>
                </div>
              ) : null}
              <div className="codez-browser-inspector-row">
                <span className="label">{t("browser.dimensions")}</span>
                <code>
                  {Math.round(selected.rect_width ?? 0)} × {Math.round(selected.rect_height ?? 0)} px
                </code>
              </div>
              {selected.text ? (
                <div className="codez-browser-inspector-row stack">
                  <span className="label">{t("browser.text")}</span>
                  <pre>{selected.text}</pre>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="codez-browser-inspector-send"
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
