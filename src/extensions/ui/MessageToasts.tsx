import { useExtensionUi } from "./useExtensionUi";

const SEVERITY_LABEL: Record<number, string> = { 0: "Error", 1: "Warning", 2: "Info" };

/** Renders vscode.window.show{Info,Warning,Error}Message toasts. */
export default function MessageToasts() {
  const { messages } = useExtensionUi();
  if (messages.length === 0) return null;
  return (
    <div className="codez-ext-toasts">
      {messages.map((m) => (
        <div key={m.id} className={`codez-ext-toast sev-${m.severity}`}>
          <div className="codez-ext-toast-row">
            <span className="codez-ext-toast-badge">{SEVERITY_LABEL[m.severity] ?? "Info"}</span>
            <span className="codez-ext-toast-msg">{m.message}</span>
            <button className="codez-ext-toast-x" onClick={() => m.resolve(undefined)} title="Dismiss">
              ✕
            </button>
          </div>
          {m.detail && <div className="codez-ext-toast-detail">{m.detail}</div>}
          {m.items.length > 0 && (
            <div className="codez-ext-toast-actions">
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
