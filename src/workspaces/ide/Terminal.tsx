import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ideApi, onTerminalOutput } from "../../services/tauri/ide";

export interface TerminalTab {
  id: string;
  title: string;
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
}

/** One PTY-backed xterm instance. Stays mounted while its tab exists. */
function TerminalSession({ terminalId, projectDir, active, panelVisible }: TerminalSessionProps) {
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const initializedRef = useRef(false);

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

  useEffect(() => {
    if (!projectDir || initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#14141c",
        foreground: "#e8e8f0",
        cursor: "#9585ff",
        cursorAccent: "#14141c",
        selectionBackground: "rgba(124, 106, 247, 0.35)",
      },
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
  }, [terminalId, projectDir, fitTerminal]);

  useEffect(() => {
    if (!active || !panelVisible) return;
    const timer = window.setTimeout(() => {
      fitTerminal();
      termRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [active, panelVisible, fitTerminal]);

  useEffect(() => {
    if (!active || !panelVisible || !containerRef.current) return;
    const ro = new ResizeObserver(() => fitTerminal());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [active, panelVisible, fitTerminal]);

  return (
    <div
      className="ide-terminal-session"
      ref={containerRef}
      style={{ display: active ? "block" : "none" }}
    />
  );
}

interface TerminalPanelProps {
  projectDir: string;
  /** Panel visibility — hiding does not destroy PTY sessions. */
  visible: boolean;
  onHide: () => void;
  height?: number;
}

export default function TerminalPanel({
  projectDir,
  visible,
  onHide,
  height = 200,
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
      title: t("ide.terminalTab", { n: seq }),
    };
  }, [t]);

  // Initialize / reset tabs when project opens or changes.
  useEffect(() => {
    seqRef.current = 1;
    const first: TerminalTab = {
      id: newTerminalId(panelIdRef.current, 1),
      title: t("ide.terminalTab", { n: 1 }),
    };
    setTabs([first]);
    setActiveTabId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on project change
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
          const ok = window.confirm(t("ide.terminalCloseTabConfirm"));
          if (!ok) return;
        }
      } catch {
        const ok = window.confirm(t("ide.terminalCloseTabConfirm"));
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

  return (
    <div
      className={`ide-terminal-panel${visible ? "" : " is-hidden"}`}
      style={visible ? { height } : undefined}
      aria-hidden={!visible}
    >
      <div className="ide-terminal-header">
        <div className="ide-terminal-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`ide-terminal-tab${tab.id === activeTabId ? " active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.title}
            >
              <span className="ide-terminal-tab-label">{tab.title}</span>
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
          ))}
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
        <button type="button" className="ide-terminal-panel-close" onClick={onHide} title={t("ide.terminalHidePanel")}>
          ✕
        </button>
      </div>
      <div className="ide-terminal-body">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.id}
            terminalId={tab.id}
            projectDir={projectDir}
            active={tab.id === activeTabId}
            panelVisible={visible}
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
    return window.confirm(t("ide.terminalCloseProjectConfirm", { count }));
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
