import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { confirmDialog } from "../../services/tauri/confirm";
import { ideApi, onTerminalOutput } from "../../services/tauri/ide";
import { cssVar } from "./useAppTheme";

export interface TerminalTab {
  id: string;
  /** 1-based tab index — label is derived at render time via i18n. */
  seq: number;
}

/** Build an xterm theme from the app's CSS theme tokens so the terminal
 *  matches light/dark. Reads computed custom properties at call time. */
function buildXtermTheme(): Record<string, string> {
  const isLight = document.documentElement.dataset.theme === "light";
  return {
    background: cssVar("--bg-primary", isLight ? "#ffffff" : "#14141c"),
    foreground: cssVar("--text-primary", isLight ? "#1a1a24" : "#e8e8f0"),
    cursor: cssVar("--accent", "#7c6af7"),
    cursorAccent: cssVar("--bg-primary", isLight ? "#ffffff" : "#14141c"),
    selectionBackground: isLight ? "rgba(107, 88, 232, 0.22)" : "rgba(124, 106, 247, 0.35)",
  };
}

/** Stable unique id; title is assigned separately from panel-local sequence. */
function newTerminalId(panelId: string, seq: number): string {
  return `ide-term-${panelId}-${seq}`;
}

interface TerminalSessionProps {
  terminalId: string;
  projectDir: string;
  active: boolean;
  panelVisible: boolean;
  onSendSelectionToChat?: (text: string) => void;
}

/** One PTY-backed xterm instance. Stays mounted while its tab exists. */
function TerminalSession({
  terminalId,
  projectDir,
  active,
  panelVisible,
  onSendSelectionToChat,
}: TerminalSessionProps) {
  const { t } = useTranslation();
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const initializedRef = useRef(false);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);

  const sendSelection = useCallback(() => {
    const text = termRef.current?.getSelection() ?? "";
    if (!text.trim() || !onSendSelectionToChat) return;
    onSendSelectionToChat(text);
    setSelectionMenu(null);
  }, [onSendSelectionToChat]);

  const fitTerminal = useCallback(() => {
    if (!containerRef.current || !fitRef.current || !termRef.current) return;
    try {
      fitRef.current.fit();
      const { cols, rows } = termRef.current;
      if (cols > 0 && rows > 0) {
        ideApi.terminalResize(terminalId, cols, rows).catch(() => {});
      }
    } catch {
      // Container may still be laying out.
    }
  }, [terminalId]);

  // Only spawn a PTY once the terminal panel is shown — avoids background
  // sessions that block project close/switch (confirm dialog) on folder open.
  useEffect(() => {
    if (!projectDir || !panelVisible || initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      lineHeight: 1.2,
      scrollback: 5000,
      theme: buildXtermTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;

    void (async () => {
      const unlisten = await onTerminalOutput((evt) => {
        if (evt.id === terminalId) term.write(evt.data);
      });
      if (cancelled) {
        unlisten();
        term.dispose();
        return;
      }
      unlistenRef.current = unlisten;

      term.onData((data) => {
        ideApi.terminalWrite(terminalId, data).catch(() => {});
      });

      term.onResize(({ cols, rows }) => {
        ideApi.terminalResize(terminalId, cols, rows).catch(() => {});
      });

      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.ctrlKey &&
          event.shiftKey &&
          event.key.toLowerCase() === "l"
        ) {
          const sel = term.getSelection();
          if (sel.trim() && onSendSelectionToChat) {
            onSendSelectionToChat(sel);
            return false;
          }
        }
        return true;
      });

      await ideApi.terminalCreate(terminalId, projectDir, term.cols || 80, term.rows || 24);

      requestAnimationFrame(() => {
        fitTerminal();
        if (active && panelVisible) term.focus();
      });
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      ideApi.terminalDestroy(terminalId).catch(() => {});
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      initializedRef.current = false;
    };
  }, [terminalId, projectDir, panelVisible, fitTerminal, onSendSelectionToChat]);

  useEffect(() => {
    if (!active || !panelVisible) return;
    const timer = window.setTimeout(() => {
      fitTerminal();
      termRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [active, panelVisible, fitTerminal]);

  // Re-theme the live terminal when the app appearance toggles light/dark.
  useEffect(() => {
    const apply = () => {
      if (termRef.current) termRef.current.options.theme = buildXtermTheme();
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !panelVisible || !containerRef.current) return;
    const ro = new ResizeObserver(() => fitTerminal());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [active, panelVisible, fitTerminal]);

  useEffect(() => {
    if (!selectionMenu) return;
    const close = () => setSelectionMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [selectionMenu]);

  return (
    <>
      <div
        className="ide-terminal-session"
        ref={containerRef}
        style={{ display: active ? "block" : "none" }}
        onContextMenu={(e) => {
          const sel = termRef.current?.getSelection() ?? "";
          if (!sel.trim() || !onSendSelectionToChat) return;
          e.preventDefault();
          setSelectionMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {selectionMenu && (
        <div
          className="ide-tab-context-menu"
          style={{ position: "fixed", left: selectionMenu.x, top: selectionMenu.y, zIndex: 1000 }}
        >
          <button type="button" onClick={sendSelection}>
            {t("ide.terminalSendSelectionToChat")}
            <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>
              {t("ide.terminalSendSelectionShortcut")}
            </span>
          </button>
        </div>
      )}
    </>
  );
}

interface TerminalPanelProps {
  projectDir: string;
  /** Panel visibility — hiding does not destroy PTY sessions. */
  visible: boolean;
  onHide: () => void;
  height?: number;
  /** When embedded in the unified BottomPanel, drop the standalone panel chrome
   *  (outer height/border/close) and fill the host container instead. */
  embedded?: boolean;
  onSendSelectionToChat?: (text: string) => void;
}

export default function TerminalPanel({
  projectDir,
  visible,
  onHide,
  height = 200,
  embedded = false,
  onSendSelectionToChat,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const panelIdRef = useRef(`p-${Math.random().toString(36).slice(2, 9)}`);
  const seqRef = useRef(0);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");

  const allocTab = useCallback((): TerminalTab => {
    seqRef.current += 1;
    const seq = seqRef.current;
    return {
      id: newTerminalId(panelIdRef.current, seq),
      seq,
    };
  }, []);

  // Initialize / reset tabs when project opens or changes.
  useEffect(() => {
    seqRef.current = 1;
    const first: TerminalTab = {
      id: newTerminalId(panelIdRef.current, 1),
      seq: 1,
    };
    setTabs([first]);
    setActiveTabId(first.id);
  }, [projectDir]);

  const addTab = useCallback(() => {
    const tab = allocTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, [allocTab]);

  const closeTab = useCallback(
    async (id: string) => {
      try {
        const alive = await ideApi.terminalIsAlive(id);
        if (alive) {
          const ok = await confirmDialog(t("ide.terminalCloseTabConfirm"));
          if (!ok) return;
        }
      } catch {
        const ok = await confirmDialog(t("ide.terminalCloseTabConfirm"));
        if (!ok) return;
      }
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((tab) => tab.id !== id);
        if (activeTabId === id) {
          const idx = prev.findIndex((tab) => tab.id === id);
          const fallback = next[Math.min(idx, next.length - 1)];
          setActiveTabId(fallback.id);
        }
        return next;
      });
    },
    [activeTabId, t],
  );

  const canAddTab = Boolean(projectDir);
  const singleTab = tabs.length <= 1;

  const className = embedded
    ? "ide-terminal-panel is-embedded"
    : `ide-terminal-panel${visible ? "" : " is-hidden"}`;

  return (
    <div
      className={className}
      style={!embedded && visible ? { height } : undefined}
      aria-hidden={!visible}
    >
      <div className="ide-terminal-header">
        <div className="ide-terminal-tabs">
          {tabs.map((tab) => {
            const label = t("ide.terminalTab", { n: tab.seq });
            return (
            <div
              key={tab.id}
              className={`ide-terminal-tab${tab.id === activeTabId ? " active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
              title={label}
            >
              <span className="ide-terminal-tab-label">{label}</span>
              <button
                type="button"
                className="ide-terminal-tab-close"
                title={t("ide.terminalCloseTab")}
                disabled={singleTab}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
            );
          })}
          <button
            type="button"
            className="ide-terminal-tab-add"
            onClick={addTab}
            disabled={!canAddTab}
            title={canAddTab ? t("ide.terminalNewTab") : t("ide.terminalNeedProject")}
          >
            +
          </button>
        </div>
        {!embedded && (
          <button type="button" className="ide-terminal-panel-close" onClick={onHide} title={t("ide.terminalHidePanel")}>
            ✕
          </button>
        )}
      </div>
      <div className="ide-terminal-body">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.id}
            terminalId={tab.id}
            projectDir={projectDir}
            active={tab.id === activeTabId}
            panelVisible={visible}
            onSendSelectionToChat={onSendSelectionToChat}
          />
        ))}
      </div>
    </div>
  );
}

/** Ask user before switching project if terminals are active; returns false if cancelled. */
export async function confirmTerminalCloseOnProjectChange(
  t: (key: string, opts?: { count: number }) => string,
): Promise<boolean> {
  try {
    const count = await ideApi.terminalCount();
    if (count <= 0) return true;
    return confirmDialog(t("ide.terminalCloseProjectConfirm", { count }));
  } catch {
    return true;
  }
}

/** Destroy all backend PTY sessions (after user confirmed project change). */
export async function destroyAllTerminals(): Promise<void> {
  try {
    await ideApi.terminalDestroyAll();
  } catch {
    // Best-effort; React unmount will also try per-tab destroy.
  }
}
