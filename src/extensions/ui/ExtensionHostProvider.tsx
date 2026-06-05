import { useEffect } from "react";
import { extensionService } from "../extensionService";
import { extensionUiStore } from "../extensionUiStore";
import MessageToasts from "./MessageToasts";
import QuickInput from "./QuickInput";
import "./extensions.css";

interface Props {
  projectDir: string | null;
  /** Whether the extension ecosystem is enabled (user setting). */
  enabled?: boolean;
}

/**
 * Owns the VS Code extension host lifecycle for the open project and renders the
 * global overlay surfaces (message toasts + quick input). All docked UI (status
 * bar items, output/debug/views/scm/tests/webviews) is rendered by the IDE
 * shell's status bar + unified bottom panel, which read the shared store.
 */
export default function ExtensionHostProvider({ projectDir, enabled = true }: Props) {
  useEffect(() => {
    if (!projectDir || !enabled) {
      void extensionService.stop();
      return;
    }
    let cancelled = false;
    extensionUiStore.setHostError(null);
    extensionService.start(projectDir).catch((e) => {
      if (!cancelled) extensionUiStore.setHostError(String(e));
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
    </>
  );
}
