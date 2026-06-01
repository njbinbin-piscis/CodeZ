import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "./services/tauri";
import { confirmTerminalCloseOnProjectChange, destroyAllTerminals } from "./workspaces/ide/Terminal";
import { getSettings } from "./services/tauri/settings";
import { setLanguage } from "./i18n";
import IdeWorkspace from "./workspaces/ide";
import AgentWorkspace from "./workspaces/agent";
import AssistantPanel from "./workspaces/ide/AssistantPanel";
import ExtensionsPanel from "./workspaces/ide/ExtensionsPanel";
import SettingsPanel from "./workspaces/ide/SettingsPanel";
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
        <div className="codez-project">
          {mode === "ide" && (
            <button
              className={`codez-chat-toggle ${chatOpen ? "active" : ""}`}
              onClick={() => setChatOpen((v) => !v)}
              title={t("app.chatTitle")}
            >
              {t("app.chat")}
            </button>
          )}
          <button
            className="codez-chat-toggle"
            onClick={() => setSettingsOpen(true)}
            title={t("app.settingsTitle")}
          >
            {t("app.settings")}
          </button>
          <button
            className="codez-chat-toggle"
            onClick={() => setExtOpen(true)}
            title={t("app.extensionsTitle")}
          >
            {t("app.extensions")}
          </button>
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
          <AgentWorkspace projectDir={projectDir} onOpenFolder={pickFolder} />
        </div>
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {extOpen && <ExtensionsPanel onClose={() => setExtOpen(false)} />}
    </div>
  );
}
