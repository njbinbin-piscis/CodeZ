import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserClickAt,
  browserClose,
  browserNavigate,
  browserPickAt,
  browserScreenshot,
  type PickedElement,
} from "../../services/tauri/browser";
import "./BrowserPanel.css";

interface BrowserPanelProps {
  visible: boolean;
  onClose: () => void;
  /** Insert a description of a picked element into the chat composer. */
  onSendElementToChat: (el: PickedElement) => void;
  /** Attach a screenshot (base64 PNG) to the chat composer. */
  onScreenshotToChat: (base64: string) => void;
}

/**
 * Cursor-style embedded browser. Renders the headless Chromium page as a polled
 * screenshot; clicks/picks are mapped back to viewport coordinates and
 * forwarded over CDP. "Pick element" sends the selected node to chat; the
 * camera button attaches a screenshot for vision-capable models.
 */
export default function BrowserPanel({
  visible,
  onClose,
  onSendElementToChat,
  onScreenshotToChat,
}: BrowserPanelProps) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshShot = useCallback(async () => {
    try {
      const b64 = await browserScreenshot();
      setShot(b64);
      setError(null);
    } catch (e) {
      // Browser not launched yet — ignore until first navigate.
      void e;
    }
  }, []);

  // Poll the page into the view while the panel is open.
  useEffect(() => {
    if (!visible) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    void refreshShot();
    pollRef.current = setInterval(() => void refreshShot(), 1200);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [visible, refreshShot]);

  const navigate = useCallback(async () => {
    const url = address.trim();
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const finalUrl = await browserNavigate(url);
      setAddress(finalUrl || url);
      await refreshShot();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [address, refreshShot]);

  // Map a click on the rendered screenshot to page viewport coordinates.
  const toPageCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * img.naturalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * img.naturalHeight;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const handleViewClick = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      const pt = toPageCoords(e);
      if (!pt) return;
      try {
        if (pickMode) {
          const el = await browserPickAt(pt.x, pt.y);
          setPickMode(false);
          if (el) onSendElementToChat(el);
        } else {
          await browserClickAt(pt.x, pt.y);
          // Give the page a beat to react, then refresh.
          setTimeout(() => void refreshShot(), 350);
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [pickMode, onSendElementToChat, refreshShot],
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
    onClose();
  }, [onClose]);

  return (
    <div className="codez-browser" hidden={!visible}>
      <div className="codez-browser-toolbar">
        <button
          className="codez-browser-btn"
          onClick={() => void refreshShot()}
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
          onClick={() => setPickMode((v) => !v)}
          title={t("browser.pickElement")}
        >
          ⌖
        </button>
        <button
          className="codez-browser-btn"
          onClick={() => void screenshotToChat()}
          title={t("browser.screenshotToChat")}
        >
          ⎙
        </button>
        <button className="codez-browser-btn" onClick={close} title={t("browser.close")}>
          ✕
        </button>
      </div>

      {error && <div className="codez-browser-error">{error}</div>}
      {pickMode && <div className="codez-browser-pickhint">{t("browser.pickHint")}</div>}

      <div className="codez-browser-view">
        {loading && <div className="codez-browser-loading">{t("browser.loading")}</div>}
        {shot ? (
          <img
            ref={imgRef}
            className={`codez-browser-shot${pickMode ? " pick" : ""}`}
            src={`data:image/png;base64,${shot}`}
            alt="page"
            onClick={(e) => void handleViewClick(e)}
            draggable={false}
          />
        ) : (
          <div className="codez-browser-empty">{t("browser.empty")}</div>
        )}
      </div>
    </div>
  );
}
