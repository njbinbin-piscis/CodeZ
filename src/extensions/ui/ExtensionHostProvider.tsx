import { useEffect, useState } from "react";
import { extensionService } from "../extensionService";
import ExtensionStatusBar from "./StatusBar";
import ExtensionPanel from "./ExtensionPanel";
import MessageToasts from "./MessageToasts";
import QuickInput from "./QuickInput";
import "./extensions.css";

interface Props {
  projectDir: string | null;
  /** Whether the extension ecosystem is enabled (user setting). */
  enabled?: boolean;
}

/**
 * Mounts the VS Code extension ecosystem for the open project: boots the host
 * sidecar, renders the global UI surfaces (toasts, quick input, status bar) and
 * the contributed-UI dock (views/output/scm/tests/debug/webviews).
 */
export default function ExtensionHostProvider({ projectDir, enabled = true }: Props) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectDir || !enabled) {
      void extensionService.stop();
      return;
    }
    let cancelled = false;
    extensionService
      .start(projectDir)
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      void extensionService.stop();
    };
  }, [projectDir, enabled]);

  if (!enabled) return null;

  return (
    <>
      <MessageToasts />
      <QuickInput />
      {panelOpen && <ExtensionPanel onClose={() => setPanelOpen(false)} />}
      <ExtensionStatusBar panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
      {error && (
        <div className="codez-ext-host-error" title={error} onClick={() => setError(null)}>
          Extension host error (click to dismiss)
        </div>
      )}
    </>
  );
}
