import { useExtensionUi } from "./useExtensionUi";

const SEVERITY_LABEL: Record<number, string> = { 0: "Error", 1: "Warning", 2: "Info" };

/** Renders vscode.window.show{Info,Warning,Error}Message toasts. */
export default function MessageToasts() {
  const { messages } = useExtensionUi();
  if (messages.length === 0) return null;
  return (
    <div className="agentz-ext-toasts">
      {messages.map((m) => (
        <div key={m.id} className={`agentz-ext-toast sev-${m.severity}`}>
          <div className="agentz-ext-toast-row">
            <span className="agentz-ext-toast-badge">{SEVERITY_LABEL[m.severity] ?? "Info"}</span>
            <span className="agentz-ext-toast-msg">{m.message}</span>
            <button className="agentz-ext-toast-x" onClick={() => m.resolve(undefined)} title="Dismiss">
              ✕
            </button>
          </div>
          {m.detail && <div className="agentz-ext-toast-detail">{m.detail}</div>}
          {m.items.length > 0 && (
            <div className="agentz-ext-toast-actions">
              {m.items.map((item) => (
                <button key={item} onClick={() => m.resolve(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
