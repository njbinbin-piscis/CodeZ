import { useCallback, useState } from "react";
import { openFolderDialog } from "./services/tauri";
import IdeWorkspace from "./workspaces/ide";
import AgentWorkspace from "./workspaces/agent";
import "./App.css";

type Mode = "ide" | "agent";

export default function App() {
  const [mode, setMode] = useState<Mode>("ide");
  const [projectDir, setProjectDir] = useState<string | null>(null);

  const pickFolder = useCallback(async () => {
    const dir = await openFolderDialog();
    if (dir) setProjectDir(dir);
  }, []);

  return (
    <div className="codez-app">
      <header className="codez-titlebar">
        <div className="codez-brand">CodeZ</div>
        <div className="codez-mode-switch">
          <button
            className={mode === "ide" ? "active" : ""}
            onClick={() => setMode("ide")}
            title="IDE mode (editor-centric)"
          >
            IDE
          </button>
          <button
            className={mode === "agent" ? "active" : ""}
            onClick={() => setMode("agent")}
            title="Agent mode (task-centric)"
          >
            Agent
          </button>
        </div>
        <div className="codez-project">
          <button className="codez-open-folder" onClick={pickFolder}>
            {projectDir ? "Change Folder" : "Open Folder"}
          </button>
          {projectDir && (
            <span className="codez-project-path" title={projectDir}>
              {projectDir}
            </span>
          )}
        </div>
      </header>

      <main className="codez-main">
        {/* Keep both workspaces mounted so editor/agent state survives a
            mode switch; hide the inactive one. */}
        <div className="codez-pane" hidden={mode !== "ide"}>
          <IdeWorkspace projectDir={projectDir} />
        </div>
        <div className="codez-pane" hidden={mode !== "agent"}>
          <AgentWorkspace projectDir={projectDir} />
        </div>
      </main>
    </div>
  );
}
