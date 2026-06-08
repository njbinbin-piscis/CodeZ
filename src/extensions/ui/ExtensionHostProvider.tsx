import { useEffect, useRef } from "react";
import { extensionService } from "../extensionService";
import { extensionUiStore } from "../extensionUiStore";
import { composerDbg } from "../../utils/composerDebug";
import MessageToasts from "./MessageToasts";
import QuickInput from "./QuickInput";
import "./extensions.css";

interface Props {
  projectDir: string | null;
  /** Wait until workspace restore finishes before booting the host. */
  ready?: boolean;
  /** Whether the extension ecosystem is enabled (user setting). */
  enabled?: boolean;
}

/**
 * Owns the VS Code extension host lifecycle for the open project and renders the
 * global overlay surfaces (message toasts + quick input). All docked UI (status
 * bar items, output/debug/views/scm/tests/webviews) is rendered by the IDE
 * shell's status bar + unified bottom panel, which read the shared store.
 */
export default function ExtensionHostProvider({
  projectDir,
  ready = true,
  enabled = true,
}: Props) {
  const activeRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    if (!ready || !projectDir || !enabled) {
      composerDbg("ExtensionHostProvider: inactive → stop", { ready, projectDir, enabled });
      activeRef.current = false;
      void extensionService.stop();
      return;
    }

    composerDbg("ExtensionHostProvider: schedule start", { projectDir, ready, enabled });
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      extensionUiStore.setHostError(null);
      void (async () => {
        try {
          await extensionService.start(projectDir);
          if (!cancelled) activeRef.current = true;
        } catch (e) {
          if (!cancelled) {
            extensionUiStore.setHostError(String(e));
          }
        }
      })();
    }, 200);

    return () => {
      // Only cancel a pending debounced start — never stop the host here.
      // Stopping on every effect cleanup caused ext-host teardown during chat
      // sends (black-screen freeze). Transitions are handled by start()'s
      // internal stop+restart or the unmount effect below.
      cancelled = true;
      window.clearTimeout(timer);
      composerDbg("ExtensionHostProvider: cleanup (timer only)", { projectDir, ready, enabled });
    };
  }, [projectDir, ready, enabled]);

  // Stop the host only when this provider unmounts (app exit / mode tear-down).
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        composerDbg("ExtensionHostProvider: unmount → stop");
        void extensionService.stop();
      }
    };
  }, []);

  if (!enabled) return null;

  return (
    <>
      <MessageToasts />
      <QuickInput />
    </>
  );
}
