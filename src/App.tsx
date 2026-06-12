import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openFolderDialog } from "./services/tauri";
import {
  workspaceLoad,
  workspaceSave,
  workspaceCloseAck,
  type EditorSnapshot,
  type LayoutSnapshot,
  type WorkspaceSnapshot,
} from "./services/tauri/workspace";
import { generateRepoWiki } from "./services/tauri/repoWiki";
import { confirmTerminalCloseOnProjectChange, destroyAllTerminals } from "./workspaces/codez/Terminal";
import { getSettings } from "./services/tauri/settings";
import { setLanguage } from "./i18n";
import { onSettingsRefresh, notifySettingsRefresh } from "./services/settingsRefresh";
import {
  getAppearanceTheme,
  toggleAppearanceTheme,
  type AppearanceTheme,
  getUiFontScale,
  applyUiFontScale,
  UI_FONT_SCALES,
  uiFontScaleLabel,
  type UiFontScale,
} from "./theme";
import { syncEditorThemeWithAppearance } from "./workspaces/codez/themeStore";
import CodeZWorkspace from "./workspaces/codez";
import WorkZWorkspace from "./workspaces/workz";
import AssistantPanel from "./workspaces/codez/AssistantPanel";
import SettingsPanel from "./workspaces/codez/SettingsPanel";
import ZLogo from "./components/ZLogo";
import { browserClose, browserCloseGuard, type PickedElement } from "./services/tauri/browser";
import type { ChatAttachment } from "./services/tauri/chat";
import { terminalSnippetPut } from "./services/tauri/terminal";
import {
  AssistantBubbleIcon,
  BrowserIcon,
  ChatIcon,
  CloseIcon,
  FolderIcon,
  MoonIcon,
  SettingsIcon,
  StoreIcon,
  SunIcon,
  WikiIcon,
} from "./components/TitleBarIcons";
import ResourceLibraryPanel, {
  type LibraryInitialState,
} from "./workspaces/codez/ResourceLibraryPanel";
import AssistantMessagesPanel from "./workspaces/codez/AssistantMessagesPanel";
import { getImSettings } from "./services/tauri/gateway";
import ExtensionHostProvider from "./extensions/ui/ExtensionHostProvider";
import { ProjectEdgeProvider } from "./contexts/ProjectEdgeContext";
import ProjectEdgeShell from "./components/ProjectEdgeShell";
import { composerDbg } from "./utils/composerDebug";
import "./App.css";

type Mode = "codez" | "workz";

/** Normalize folder paths before comparing (slashes, trailing slash). */
function normProjectPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export default function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("workz");
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("agentz-chat-width"));
    return Number.isFinite(saved) && saved >= 340 ? Math.min(760, saved) : 380;
  });
  const [chatInsert, setChatInsert] = useState<{ paths: string[]; nonce: number } | null>(null);
  const [chatInsertElement, setChatInsertElement] = useState<{
    element: PickedElement;
    nonce: number;
  } | null>(null);
  const [chatInsertTerminal, setChatInsertTerminal] = useState<{
    snippetId: string;
    text: string;
    nonce: number;
  } | null>(null);
  const [chatAttach, setChatAttach] = useState<{
    attachment: ChatAttachment;
    preview: string | null;
    nonce: number;
  } | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryInitial, setLibraryInitial] = useState<LibraryInitialState | null>(null);
  const [assistantPanelOpen, setAssistantPanelOpen] = useState(false);
  const [hasImAssistant, setHasImAssistant] = useState(false);
  const [wikiBuildNonce, setWikiBuildNonce] = useState(0);
  const [wikiBusy, setWikiBusy] = useState(false);
  const [settingsToast, setSettingsToast] = useState<string | null>(null);
  const [ideWikiOpenPath, setIdeWikiOpenPath] = useState<{ path: string; nonce: number } | null>(
    null,
  );
  const [appearance, setAppearance] = useState<AppearanceTheme>(() => getAppearanceTheme());
  const [fontScale, setFontScale] = useState<UiFontScale>(() => getUiFontScale());
  const [fontScaleOpen, setFontScaleOpen] = useState(false);
  const fontScaleRef = useRef<HTMLDivElement>(null);
  const [exitToast, setExitToast] = useState(false);
  const [workspaceRestore, setWorkspaceRestore] = useState<{
    key: number;
    editor: EditorSnapshot;
    layout: LayoutSnapshot;
  } | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  const editorPatchRef = useRef<EditorSnapshot>({
    open_paths: [],
    active_path: null,
    dirty_buffers: {},
  });
  const ideLayoutPatchRef = useRef<
    Pick<
      LayoutSnapshot,
      | "sidebar_tab"
      | "sidebar_collapsed"
      | "sidebar_width"
      | "bottom_open"
      | "bottom_tab"
      | "bottom_height"
      | "explorer_expanded_paths"
    >
  >({
    sidebar_tab: "explorer",
    sidebar_collapsed: false,
    sidebar_width: 260,
    bottom_open: false,
    bottom_tab: "terminal",
    bottom_height: 240,
    explorer_expanded_paths: [],
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildWorkspaceSnapshot = useCallback((): WorkspaceSnapshot => {
    return {
      version: 1,
      project_dir: projectDir,
      editor: editorPatchRef.current,
      layout: {
        chat_open: chatOpen,
        chat_width: chatWidth,
        browser_open: browserOpen,
        mode,
        ...ideLayoutPatchRef.current,
      },
    };
  }, [projectDir, chatOpen, chatWidth, browserOpen, mode]);

  const persistWorkspace = useCallback(
    async (snap?: WorkspaceSnapshot) => {
      try {
        await workspaceSave(snap ?? buildWorkspaceSnapshot());
      } catch (e) {
        console.error("workspace save failed:", e);
      }
    },
    [buildWorkspaceSnapshot],
  );

  const scheduleWorkspaceSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistWorkspace();
    }, 600);
  }, [persistWorkspace]);

  const handleWorkspacePatch = useCallback(
    (patch: {
      editor: EditorSnapshot;
      layout: Pick<
        LayoutSnapshot,
        "sidebar_tab" | "sidebar_collapsed" | "sidebar_width" | "bottom_open" | "bottom_tab" | "bottom_height"
      >;
    }) => {
      editorPatchRef.current = patch.editor;
      ideLayoutPatchRef.current = patch.layout;
      scheduleWorkspaceSave();
    },
    [scheduleWorkspaceSave],
  );

  // Restore last session on startup.
  useEffect(() => {
    let cancelled = false;
    void workspaceLoad()
      .then((snap) => {
        if (cancelled || !snap?.project_dir) {
          setWorkspaceReady(true);
          return;
        }
        const layout = snap.layout ?? ({} as LayoutSnapshot);
        if (layout.mode === "codez" || layout.mode === "workz") setMode(layout.mode);
        if (typeof layout.chat_open === "boolean") setChatOpen(layout.chat_open);
        if (layout.chat_width && layout.chat_width >= 340) setChatWidth(layout.chat_width);
        if (layout.browser_open) setBrowserOpen(true);
        ideLayoutPatchRef.current = {
          sidebar_tab: layout.sidebar_tab || "explorer",
          sidebar_collapsed: layout.sidebar_collapsed ?? false,
          sidebar_width: layout.sidebar_width && layout.sidebar_width >= 220 ? layout.sidebar_width : 260,
          bottom_open: layout.bottom_open ?? false,
          bottom_tab: layout.bottom_tab || "terminal",
          bottom_height: layout.bottom_height && layout.bottom_height >= 120 ? layout.bottom_height : 240,
        };
        editorPatchRef.current = snap.editor ?? editorPatchRef.current;
        setWorkspaceRestore({
          key: 1,
          editor: snap.editor,
          layout: {
            chat_open: layout.chat_open ?? true,
            chat_width: layout.chat_width ?? 380,
            browser_open: layout.browser_open ?? false,
            mode: layout.mode === "workz" ? "workz" : "codez",
            ...ideLayoutPatchRef.current,
          },
        });
        setProjectDir(snap.project_dir);
        setWorkspaceReady(true);
      })
      .catch(() => setWorkspaceReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist layout prefs (mode, chat panel) and save on close.
  useEffect(() => {
    if (!workspaceReady) return;
    scheduleWorkspaceSave();
  }, [workspaceReady, mode, chatOpen, chatWidth, browserOpen, projectDir, scheduleWorkspaceSave]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("app-before-close", () => {
      setExitToast(true);
      void (async () => {
        try {
          await persistWorkspace();
          await workspaceCloseAck();
        } catch (e) {
          console.error("workspace close failed:", e);
          setExitToast(false);
        }
      })();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [persistWorkspace]);

  useEffect(() => {
    const applyLanguage = () => {
      getSettings()
        .then((s) => {
          if (s.language === "zh" || s.language === "en") {
            setLanguage(s.language);
          }
        })
        .catch(() => {
          // config may not exist yet — keep browser-detected language
        });
    };
    applyLanguage();
    const offLang = onSettingsRefresh(applyLanguage);
    const offToast = onSettingsRefresh(() => {
      setSettingsToast(t("settings.savedEffectHint"));
      window.setTimeout(() => setSettingsToast((cur) => (cur === t("settings.savedEffectHint") ? null : cur)), 3200);
    });
    return () => {
      offLang();
      offToast();
    };
  }, [t]);

  // Surface the assistant message panel button only once an IM channel is
  // configured. Re-check whenever settings are saved.
  useEffect(() => {
    const detect = () => {
      getImSettings()
        .then((s) => {
          setHasImAssistant(
            Boolean(
              s.feishu_enabled ||
                s.wecom_enabled ||
                s.dingtalk_enabled ||
                s.telegram_enabled ||
                s.slack_enabled ||
                s.discord_enabled ||
                s.teams_enabled ||
                s.matrix_enabled ||
                s.webhook_enabled ||
                s.wechat_enabled,
            ),
          );
        })
        .catch(() => setHasImAssistant(false));
    };
    detect();
    const off = onSettingsRefresh(detect);
    // The agent's `app_control` tool mutates settings/assistants in the backend;
    // bridge its event to the same in-app refresh open panels already listen to.
    const un = listen("agentz:app-control-updated", () => {
      notifySettingsRefresh();
      detect();
    });
    return () => {
      off();
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!fontScaleOpen) return;
    const close = (e: MouseEvent) => {
      if (fontScaleRef.current && !fontScaleRef.current.contains(e.target as Node)) {
        setFontScaleOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [fontScaleOpen]);

  const pickFolder = useCallback(async () => {
    try {
      const dir = await openFolderDialog(projectDir);
      if (!dir) return;
      if (projectDir && normProjectPath(dir) === normProjectPath(projectDir)) return;
      if (projectDir) {
        const ok = await confirmTerminalCloseOnProjectChange(t);
        if (!ok) return;
        await destroyAllTerminals();
      }
      setIdeWikiOpenPath(null);
      setChatInsertElement(null);
      await persistWorkspace();
      setProjectDir(dir);
    } catch (e) {
      console.error("pickFolder failed:", e);
    }
  }, [projectDir, t, persistWorkspace]);

  const closeProject = useCallback(async () => {
    if (!projectDir) return;
    try {
      const ok = await confirmTerminalCloseOnProjectChange(t);
      if (!ok) return;
      await destroyAllTerminals();
      setIdeWikiOpenPath(null);
      try {
        const guard = await browserCloseGuard();
        if (!guard.can_close || guard.agent_active) {
          const msg = guard.reason ?? t("browser.closeConfirm");
          // eslint-disable-next-line no-alert
          if (!window.confirm(msg)) return;
        }
      } catch {
        // eslint-disable-next-line no-alert
        if (!window.confirm(t("browser.closeConfirm"))) return;
      }
      setBrowserOpen(false);
      setChatInsertElement(null);
      void browserClose().catch(() => {});
      await persistWorkspace();
      setProjectDir(null);
    } catch (e) {
      console.error("closeProject failed:", e);
    }
  }, [projectDir, t, persistWorkspace]);

  const handleSendToChat = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    composerDbg("explorer → sendToChat", {
      paths,
      dirs: paths.map((p) => /[/\\]$/.test(p)),
    });
    setChatOpen(true);
    setChatInsert({ paths, nonce: Date.now() });
  }, []);

  const handleSendTerminalToChat = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setChatOpen(true);
    try {
      const snippetId = await terminalSnippetPut(trimmed);
      setChatInsertTerminal({ snippetId, text: trimmed, nonce: Date.now() });
    } catch (e) {
      console.error("terminalSnippetPut failed:", e);
    }
  }, []);

  const handleSendElementToChat = useCallback(
    (el: PickedElement) => {
      if (!projectDir) return;
      setChatOpen(true);
      setChatInsertElement({ element: el, nonce: Date.now() });
    },
    [projectDir],
  );

  const handleScreenshotToChat = useCallback(
    (base64: string) => {
      if (!projectDir) return;
      setChatOpen(true);
    setChatAttach({
      attachment: {
        media_type: "image/png",
        data: base64,
        filename: `browser-${Date.now()}.png`,
        path: null,
      },
      preview: `data:image/png;base64,${base64}`,
      nonce: Date.now(),
    });
    },
    [projectDir],
  );

  const handleWikiClick = useCallback(async () => {
    if (!projectDir || wikiBusy) return;
    if (mode === "workz") {
      setWikiBuildNonce((n) => n + 1);
      return;
    }
    setWikiBusy(true);
    try {
      const res = await generateRepoWiki(projectDir);
      setIdeWikiOpenPath({ path: res.path, nonce: Date.now() });
    } catch (e) {
      console.error("Repo wiki generation failed:", e);
    } finally {
      setWikiBusy(false);
    }
  }, [projectDir, wikiBusy, mode]);

  const handleThemeToggle = useCallback(() => {
    const next = toggleAppearanceTheme();
    setAppearance(next);
    syncEditorThemeWithAppearance(next);
  }, []);

  // Drag the divider between the editor and the chat panel. The chat sits on
  // the right, so dragging the handle left widens it.
  const startChatResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        setChatWidth(Math.min(760, Math.max(340, startW + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [chatWidth],
  );

  useEffect(() => {
    localStorage.setItem("agentz-chat-width", String(chatWidth));
  }, [chatWidth]);

  return (
    <ProjectEdgeProvider>
    <div className="agentz-app">
      <header className="agentz-titlebar">
        <div className="agentz-brand" aria-label={`AgentZ v${__APP_VERSION__}`}>
          <span className="agentz-brand-text">Agent</span>
          <ZLogo size={22} className="agentz-brand-z" />
          <span className="agentz-brand-ver" title={`v${__APP_VERSION__}`}>
            v{__APP_VERSION__}
          </span>
        </div>

        <button
          type="button"
          className="agentz-titlebar-icon agentz-titlebar-folder"
          onClick={() => void pickFolder()}
          title={projectDir ? t("app.changeFolder") : t("app.openFolder")}
          aria-label={projectDir ? t("app.changeFolder") : t("app.openFolder")}
        >
          <FolderIcon />
        </button>

        <span className="agentz-project-path" title={projectDir ?? undefined}>
          {projectDir ?? t("app.noProjectOpen")}
        </span>
        {projectDir && (
          <button
            type="button"
            className="agentz-titlebar-icon agentz-titlebar-close-project"
            onClick={() => void closeProject()}
            title={t("app.closeFolder")}
            aria-label={t("app.closeFolder")}
          >
            <CloseIcon size={16} />
          </button>
        )}

        <div className="agentz-titlebar-actions">
          {mode === "codez" && (
            <button
              type="button"
              className={`agentz-titlebar-icon ${browserOpen ? "active" : ""}`}
              onClick={() => projectDir && setBrowserOpen((v) => !v)}
              disabled={!projectDir}
              title={projectDir ? t("app.browserTitle") : t("app.browserNeedsProject")}
              aria-label={projectDir ? t("app.browserTitle") : t("app.browserNeedsProject")}
            >
              <BrowserIcon />
            </button>
          )}
          {mode === "codez" && (
            <button
              type="button"
              className={`agentz-titlebar-icon ${chatOpen ? "active" : ""}`}
              onClick={() => setChatOpen((v) => !v)}
              title={t("app.chatTitle")}
              aria-label={t("app.chatTitle")}
            >
              <ChatIcon />
            </button>
          )}
          {hasImAssistant && (
            <button
              type="button"
              className={`agentz-titlebar-icon ${assistantPanelOpen ? "active" : ""}`}
              onClick={() => setAssistantPanelOpen((v) => !v)}
              title={t("assistantPanel.title")}
              aria-label={t("assistantPanel.title")}
            >
              <AssistantBubbleIcon />
            </button>
          )}
          <button
            type="button"
            className={`agentz-titlebar-icon${wikiBusy ? " loading" : ""}`}
            onClick={() => void handleWikiClick()}
            disabled={!projectDir || wikiBusy}
            title={t("agent.repoWikiHint")}
            aria-label={t("agent.repoWiki")}
          >
            <WikiIcon />
          </button>
          <div className="agentz-font-scale-menu" ref={fontScaleRef}>
            <button
              type="button"
              className={`agentz-titlebar-icon${fontScaleOpen ? " active" : ""}`}
              title={t("app.fontScaleTitle")}
              aria-label={t("app.fontScale")}
              aria-expanded={fontScaleOpen}
              aria-haspopup="menu"
              onClick={() => setFontScaleOpen((v) => !v)}
            >
              Aa
            </button>
            {fontScaleOpen && (
              <div className="agentz-font-scale-popover" role="menu">
                {UI_FONT_SCALES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitemradio"
                    aria-checked={fontScale === s}
                    className={fontScale === s ? "active" : ""}
                    onClick={() => {
                      applyUiFontScale(s);
                      setFontScale(s);
                      setFontScaleOpen(false);
                    }}
                  >
                    {uiFontScaleLabel(s)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="agentz-titlebar-icon"
            onClick={handleThemeToggle}
            title={
              appearance === "dark" ? t("app.themeSwitchLight") : t("app.themeSwitchDark")
            }
            aria-label={
              appearance === "dark" ? t("app.themeSwitchLight") : t("app.themeSwitchDark")
            }
          >
            {appearance === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="agentz-titlebar-icon"
            onClick={() => {
              setLibraryInitial(null);
              setLibraryOpen(true);
            }}
            title={t("library.title")}
            aria-label={t("library.title")}
          >
            <StoreIcon />
          </button>
          <button
            type="button"
            className="agentz-titlebar-icon"
            onClick={() => setSettingsOpen(true)}
            title={t("app.settingsTitle")}
            aria-label={t("app.settingsTitle")}
          >
            <SettingsIcon />
          </button>
        </div>

        <div className="agentz-mode-switch">
          <button
            className={mode === "workz" ? "active" : ""}
            onClick={() => setMode("workz")}
            title={t("app.modeWorkZTitle")}
          >
            {t("app.modeWorkZ")}
          </button>
          <button
            className={mode === "codez" ? "active" : ""}
            onClick={() => setMode("codez")}
            title={t("app.modeCodeZTitle")}
          >
            {t("app.modeCodeZ")}
          </button>
        </div>
      </header>

      <main className="agentz-main">
        <div className="agentz-pane" hidden={mode !== "codez"}>
          <div className="agentz-ide-split">
            <div className="agentz-ide-main">
              <CodeZWorkspace
                projectDir={projectDir}
                onOpenFolder={pickFolder}
                onSendToChat={handleSendToChat}
                onSendTerminalToChat={handleSendTerminalToChat}
                openPathRequest={ideWikiOpenPath}
                onOpenPathRequestHandled={() => setIdeWikiOpenPath(null)}
                browserOpen={browserOpen}
                onBrowserOpenChange={setBrowserOpen}
                onSendElementToChat={handleSendElementToChat}
                onScreenshotToChat={handleScreenshotToChat}
                workspaceRestore={workspaceRestore}
                onWorkspacePatch={handleWorkspacePatch}
              />
            </div>
            <div
              className="agentz-ide-chat-resize"
              onMouseDown={startChatResize}
              hidden={!chatOpen}
              role="separator"
              aria-orientation="vertical"
            />
            {/* Kept mounted while in IDE mode so toggling chat visibility never
                discards the active session — only show/hide. */}
            <div className="agentz-ide-chat" style={{ width: chatWidth }} hidden={!chatOpen}>
              <AssistantPanel
                projectDir={projectDir}
                insertRequest={chatInsert}
                insertElementRequest={chatInsertElement}
                insertTerminalRequest={chatInsertTerminal}
                attachRequest={chatAttach}
                onAttachRequestHandled={() => setChatAttach(null)}
              />
            </div>
          </div>
        </div>
        <div className="agentz-pane" hidden={mode !== "workz"}>
          <WorkZWorkspace
            projectDir={projectDir}
            onOpenFolder={pickFolder}
            wikiBuildNonce={wikiBuildNonce}
            onWikiBusyChange={setWikiBusy}
            onOpenLibrary={(initial) => {
              setLibraryInitial(initial ?? null);
              setLibraryOpen(true);
            }}
          />
        </div>
      </main>

      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} projectDir={projectDir} />
      )}
      {libraryOpen && (
        <ResourceLibraryPanel
          initial={libraryInitial}
          onClose={() => {
            setLibraryOpen(false);
            setLibraryInitial(null);
          }}
        />
      )}
      {assistantPanelOpen && (
        <AssistantMessagesPanel onClose={() => setAssistantPanelOpen(false)} />
      )}

      {/* Project-scoped extension host — must live outside CodeZ/WorkZ panes so
          workspace auto-restore always boots extensions (not only after manual
          folder pick or switching back to CodeZ). */}
      <ExtensionHostProvider projectDir={projectDir} ready={workspaceReady} />

      {(exitToast || settingsToast) && (
        <div className="agentz-exit-toast" role="status" aria-live="polite">
          {exitToast ?? settingsToast}
        </div>
      )}

      <ProjectEdgeShell projectDir={projectDir} />
    </div>
    </ProjectEdgeProvider>
  );
}
