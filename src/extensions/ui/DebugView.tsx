import { useSyncExternalStore } from "react";
import { debugStore } from "../debug/debugStore";
import { debugController } from "../debug/debugController";
import { useExtensionUi } from "./useExtensionUi";

/** Debug session view: toolbar + call stack + variables + console. */
export default function DebugView() {
  const dbg = useSyncExternalStore(debugStore.subscribe, debugStore.getSnapshot);
  const { debugOutput } = useExtensionUi();

  return (
    <div className="agentz-debug-view">
      <div className="agentz-debug-toolbar">
        {dbg.active ? (
          <>
            <button onClick={() => void debugController.continue()} disabled={dbg.running} title="Continue">
              ▶
            </button>
            <button onClick={() => void debugController.stepOver()} disabled={dbg.running} title="Step over">
              ⤼
            </button>
            <button onClick={() => void debugController.stepInto()} disabled={dbg.running} title="Step into">
              ⤓
            </button>
            <button onClick={() => void debugController.stepOut()} disabled={dbg.running} title="Step out">
              ⤒
            </button>
            <button onClick={() => void debugController.stop()} title="Stop" className="agentz-debug-stop">
              ■
            </button>
            <span className="agentz-debug-state">{dbg.running ? "running" : "paused"}</span>
          </>
        ) : (
          <span className="agentz-debug-idle">No active debug session. Start one via an extension launch config.</span>
        )}
      </div>

      {dbg.active && (
        <div className="agentz-debug-cols">
          <div className="agentz-debug-col">
            <div className="agentz-ext-view-title">Call Stack</div>
            {dbg.frames.length === 0 ? (
              <div className="agentz-debug-muted">—</div>
            ) : (
              dbg.frames.map((f) => (
                <div key={f.id} className="agentz-debug-frame">
                  {f.name} <span className="agentz-debug-muted">:{f.line}</span>
                </div>
              ))
            )}
          </div>
          <div className="agentz-debug-col">
            <div className="agentz-ext-view-title">Variables</div>
            {dbg.variables.length === 0 ? (
              <div className="agentz-debug-muted">—</div>
            ) : (
              dbg.variables.map((v) => (
                <div key={v.name} className="agentz-debug-var">
                  <span className="agentz-debug-var-name">{v.name}</span>
                  <span className="agentz-debug-var-val">{v.value}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="agentz-ext-view-title">Debug Console</div>
      <pre className="agentz-ext-debug">{debugOutput.length === 0 ? "No debug output." : debugOutput.join("\n")}</pre>
    </div>
  );
}
