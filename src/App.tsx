import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "./services/tauri";
import { generateRepoWiki } from "./services/tauri/repoWiki";
import { confirmTerminalCloseOnProjectChange, destroyAllTerminals } from "./workspaces/ide/Terminal";
import { getSettings } from "./services/tauri/settings";
import { setLanguage } from "./i18n";
import IdeWorkspace from "./workspaces/ide";
import AgentWorkspace from "./workspaces/agent";
import AssistantPanel from "./workspaces/ide/AssistantPanel";
import ExtensionsPanel from "./workspaces/ide/ExtensionsPanel";
import SettingsPanel from "./workspaces/ide/SettingsPanel";
import ClawHubPanel from "./workspaces/agent/ClawHubPanel";
import {
  ChatIcon,
  ClawHubIcon,
  ExtensionsIcon,
  SettingsIcon,
  WikiIcon,
} from "./components/TitleBarIcons";
import "./App.css";

type Mode = "ide" | "agent";

export default function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("ide");
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInsert, setChatInsert] = useState<{ paths: string[]; nonce: number } | null>(null);
  const [extOpen, setExtOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clawHubOpen, setClawHubOpen] = useState(false);
  const [wikiBuildNonce, setWikiBuildNonce] = useState(0);
  const [wikiBusy, setWikiBusy] = useState(false);
  const [ideWikiOpenPath, setIdeWikiOpenPath] = useState<{ path: string; nonce: number } | null>(
    null,
  );

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
    const dir = await openFolderDialog();
    if (!dir) return;
    if (projectDir && dir !== projectDir) {
      const ok = await confirmTerminalCloseOnProjectChange(t);
      if (!ok) return;
      await destroyAllTerminals();
    }
    setProjectDir(dir);
  }, [projectDir, t]);

  const handleSendToChat = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setChatOpen(true);
    setChatInsert({ paths, nonce: Date.now() });
  }, []);

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

  return (
    <div className="codez-app">
      <header className="codez-titlebar">
        <div className="codez-brand">CodeZ</div>
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
        <div className="codez-titlebar-actions">
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
            className="codez-titlebar-icon"
            onClick={() => setClawHubOpen(true)}
            title={t("clawhub.open")}
            aria-label={t("clawhub.open")}
          >
            <ClawHubIcon />
          </button>
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
          <span className="codez-titlebar-sep" aria-hidden />
          <button
            type="button"
            className="codez-titlebar-icon"
            onClick={() => setSettingsOpen(true)}
            title={t("app.settingsTitle")}
            aria-label={t("app.settingsTitle")}
          >
            <SettingsIcon />
          </button>
          <button
            type="button"
            className="codez-titlebar-icon"
            onClick={() => setExtOpen(true)}
            title={t("app.extensionsTitle")}
            aria-label={t("app.extensionsTitle")}
          >
            <ExtensionsIcon />
          </button>
        </div>
        <div className="codez-project">
          {projectDir && (
            <>
              <button className="codez-open-folder codez-open-folder-secondary" onClick={pickFolder}>
                {t("app.changeFolder")}
              </button>
              <span className="codez-project-path" title={projectDir}>
                {projectDir}
              </span>
            </>
          )}
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
                openPathRequest={ideWikiOpenPath}
              />
            </div>
            {chatOpen && (
              <div className="codez-ide-chat">
                <AssistantPanel
                  projectDir={projectDir}
                  onClose={() => setChatOpen(false)}
                  insertRequest={chatInsert}
                />
              </div>
            )}
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
      {extOpen && <ExtensionsPanel onClose={() => setExtOpen(false)} />}
      {clawHubOpen && <ClawHubPanel onClose={() => setClawHubOpen(false)} />}
    </div>
  );
}
