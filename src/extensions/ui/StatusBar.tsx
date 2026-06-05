import { extensionService } from "../extensionService";
import { useExtensionUi } from "./useExtensionUi";

interface StatusBarProps {
  onTogglePanel: () => void;
  panelOpen: boolean;
}

/** Bottom status bar showing extension-contributed status bar items. */
export default function ExtensionStatusBar({ onTogglePanel, panelOpen }: StatusBarProps) {
  const { statusBar, running, scm } = useExtensionUi();
  const left = statusBar.filter((s) => s.alignment === 1);
  const right = statusBar.filter((s) => s.alignment === 2);

  const render = (entry: (typeof statusBar)[number]) => (
    <button
      key={entry.id}
      className="codez-statusbar-item"
      title={entry.tooltip}
      style={entry.color ? { color: entry.color } : undefined}
      onClick={() => entry.command && void extensionService.executeCommand(entry.command)}
    >
      {entry.text}
    </button>
  );

  return (
    <div className="codez-statusbar">
      <button
        className={`codez-statusbar-item codez-statusbar-ext ${running ? "running" : ""}`}
        title={running ? "Extension host running" : "Extension host stopped"}
        onClick={onTogglePanel}
      >
        {running ? "$(extensions) Extensions" : "Extensions off"}
        {panelOpen ? " ▾" : " ▴"}
      </button>
      {scm.length > 0 && (
        <span className="codez-statusbar-item" title="Source control providers">
          SCM: {scm.length}
        </span>
      )}
      {left.map(render)}
      <div style={{ flex: 1 }} />
      {right.map(render)}
    </div>
  );
}
