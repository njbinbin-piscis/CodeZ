import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "./services/tauri";
import { generateRepoWiki } from "./services/tauri/repoWiki";
import { confirmTerminalCloseOnProjectChange, destroyAllTerminals } from "./workspaces/ide/Terminal";
import { getSettings } from "./services/tauri/settings";
import { setLanguage } from "./i18n";
import {
  getAppearanceTheme,
  toggleAppearanceTheme,
  type AppearanceTheme,
} from "./theme";
import IdeWorkspace from "./workspaces/ide";
import AgentWorkspace from "./workspaces/agent";
import AssistantPanel from "./workspaces/ide/AssistantPanel";
import SettingsPanel from "./workspaces/ide/SettingsPanel";
import ZLogo from "./components/ZLogo";
import { browserClose, type PickedElement } from "./services/tauri/browser";
import type { ChatAttachment } from "./services/tauri/chat";
import { terminalSnippetPut } from "./services/tauri/terminal";
import {
  BrowserIcon,
  ChatIcon,
  CloseIcon,
  FolderIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  WikiIcon,
} from "./components/TitleBarIcons";
import "./App.css";

type Mode = "ide" | "agent";

/** Normalize folder paths before comparing (slashes, trailing slash). */
function normProjectPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export default function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("ide");
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("codez-chat-width"));
    return Number.isFinite(saved) && saved >= 280 ? Math.min(760, saved) : 380;
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
  const [wikiBuildNonce, setWikiBuildNonce] = useState(0);
  const [wikiBusy, setWikiBusy] = useState(false);
  const [ideWikiOpenPath, setIdeWikiOpenPath] = useState<{ path: string; nonce: number } | null>(
    null,
  );
  const [appearance, setAppearance] = useState<AppearanceTheme>(() => getAppearanceTheme());

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (s.language === "zh" || s.language === "en") {
          setLanguage(s.language);
        }
      })
      .catch(() => {
        // config may not exist yet — keep browser-detected language
      });
  }, []);

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
      setProjectDir(dir);
    } catch (e) {
      console.error("pickFolder failed:", e);
    }
  }, [projectDir, t]);

  const closeProject = useCallback(async () => {
    if (!projectDir) return;
    try {
      const ok = await confirmTerminalCloseOnProjectChange(t);
      if (!ok) return;
      await destroyAllTerminals();
      setIdeWikiOpenPath(null);
      setBrowserOpen(false);
      setChatInsertElement(null);
      void browserClose().catch(() => {});
      setProjectDir(null);
    } catch (e) {
      console.error("closeProject failed:", e);
    }
  }, [projectDir, t]);

  const handleSendToChat = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
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
    if (mode === "agent") {
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
        setChatWidth(Math.min(760, Math.max(280, startW + delta)));
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
    localStorage.setItem("codez-chat-width", String(chatWidth));
  }, [chatWidth]);

  return (
    <div className="codez-app">
      <header className="codez-titlebar">
        <div className="codez-brand" aria-label="CodeZ">
          <span className="codez-brand-text">Code</span>
          <ZLogo size={22} className="codez-brand-z" />
        </div>

        <button
          type="button"
          className="codez-titlebar-icon codez-titlebar-folder"
          onClick={() => void pickFolder()}
          title={projectDir ? t("app.changeFolder") : t("app.openFolder")}
          aria-label={projectDir ? t("app.changeFolder") : t("app.openFolder")}
        >
          <FolderIcon />
        </button>

        <span className="codez-project-path" title={projectDir ?? undefined}>
          {projectDir ?? t("app.noProjectOpen")}
        </span>
        {projectDir && (
          <button
            type="button"
            className="codez-titlebar-icon codez-titlebar-close-project"
            onClick={() => void closeProject()}
            title={t("app.closeFolder")}
            aria-label={t("app.closeFolder")}
          >
            <CloseIcon size={16} />
          </button>
        )}

        <div className="codez-titlebar-actions">
          {mode === "ide" && (
            <button
              type="button"
              className={`codez-titlebar-icon ${browserOpen ? "active" : ""}`}
              onClick={() => projectDir && setBrowserOpen((v) => !v)}
              disabled={!projectDir}
              title={projectDir ? t("app.browserTitle") : t("app.browserNeedsProject")}
              aria-label={projectDir ? t("app.browserTitle") : t("app.browserNeedsProject")}
            >
              <BrowserIcon />
            </button>
          )}
          {mode === "ide" && (
            <button
              type="button"
              className={`codez-titlebar-icon ${chatOpen ? "active" : ""}`}
              onClick={() => setChatOpen((v) => !v)}
              title={t("app.chatTitle")}
              aria-label={t("app.chatTitle")}
            >
              <ChatIcon />
            </button>
          )}
          <button
            type="button"
            className={`codez-titlebar-icon${wikiBusy ? " loading" : ""}`}
            onClick={() => void handleWikiClick()}
            disabled={!projectDir || wikiBusy}
            title={t("agent.repoWikiHint")}
            aria-label={t("agent.repoWiki")}
          >
            <WikiIcon />
          </button>
          <button
            type="button"
            className="codez-titlebar-icon"
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
            className="codez-titlebar-icon"
            onClick={() => setSettingsOpen(true)}
            title={t("app.settingsTitle")}
            aria-label={t("app.settingsTitle")}
          >
            <SettingsIcon />
          </button>
        </div>

        <div className="codez-mode-switch">
          <button
            className={mode === "ide" ? "active" : ""}
            onClick={() => setMode("ide")}
            title={t("app.modeIdeTitle")}
          >
            {t("app.modeIde")}
          </button>
          <button
            className={mode === "agent" ? "active" : ""}
            onClick={() => setMode("agent")}
            title={t("app.modeAgentTitle")}
          >
            {t("app.modeAgent")}
          </button>
        </div>
      </header>

      <main className="codez-main">
        <div className="codez-pane" hidden={mode !== "ide"}>
          <div className="codez-ide-split">
            <div className="codez-ide-main">
              <IdeWorkspace
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
              />
            </div>
            <div
              className="codez-ide-chat-resize"
              onMouseDown={startChatResize}
              hidden={!chatOpen}
              role="separator"
              aria-orientation="vertical"
            />
            {/* Kept mounted while in IDE mode so toggling chat visibility never
                discards the active session — only show/hide. */}
            <div className="codez-ide-chat" style={{ width: chatWidth }} hidden={!chatOpen}>
              <AssistantPanel
                projectDir={projectDir}
                insertRequest={chatInsert}
                insertElementRequest={chatInsertElement}
                insertTerminalRequest={chatInsertTerminal}
                attachRequest={chatAttach}
              />
            </div>
          </div>
        </div>
        <div className="codez-pane" hidden={mode !== "agent"}>
          <AgentWorkspace
            projectDir={projectDir}
            onOpenFolder={pickFolder}
            wikiBuildNonce={wikiBuildNonce}
            onWikiBusyChange={setWikiBusy}
          />
        </div>
      </main>

      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} projectDir={projectDir} />
      )}
    </div>
  );
}
