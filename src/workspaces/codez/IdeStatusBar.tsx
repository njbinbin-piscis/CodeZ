import { useTranslation } from "react-i18next";
import { useExtensionUi } from "../../extensions/ui/useExtensionUi";
import { extensionService } from "../../extensions/extensionService";
import { extensionUiStore } from "../../extensions/extensionUiStore";
import type { BottomTab } from "./BottomPanel";

interface IdeStatusBarProps {
  onOpenPanel: (tab: BottomTab) => void;
  /** Open the Extensions sidebar (marketplace + enable/disable). */
  onOpenExtensions: () => void;
}

/**
 * Full-width application status bar. Extension indicator opens the marketplace
 * when the host is off, or extension output when running.
 */
export default function IdeStatusBar({ onOpenPanel, onOpenExtensions }: IdeStatusBarProps) {
  const { t } = useTranslation();
  const { statusBar, running, scm, hostError } = useExtensionUi();
  const left = statusBar.filter((s) => s.alignment === 1);
  const right = statusBar.filter((s) => s.alignment === 2);

  const renderItem = (entry: (typeof statusBar)[number]) => (
    <button
      key={entry.id}
      className="ide-status-item"
      title={entry.tooltip}
      style={entry.color ? { color: entry.color } : undefined}
      onClick={() => entry.command && void extensionService.executeCommand(entry.command)}
    >
      {entry.text}
    </button>
  );

  const handleExtClick = () => {
    if (running) {
      onOpenPanel("output");
    } else {
      onOpenExtensions();
    }
  };

  return (
    <div className="ide-status-bar">
      <button
        className={`ide-status-item ide-status-ext ${running ? "running" : ""}`}
        title={running ? t("extensions.hostRunning") : t("extensions.hostOffHint")}
        onClick={handleExtClick}
      >
        <span className="ide-status-dot" />
        {running ? t("extensions.nav") : t("extensions.hostOff")}
      </button>

      {scm.length > 0 && (
        <button className="ide-status-item" title={t("ide.sourceControl")} onClick={() => onOpenPanel("scm")}>
          ⑂ {scm.length}
        </button>
      )}

      {left.map(renderItem)}

      <div className="ide-status-spacer" />

      {right.map(renderItem)}

      {hostError && (
        <button
          className="ide-status-item ide-status-error"
          title={hostError}
          onClick={() => extensionUiStore.setHostError(null)}
        >
          ⚠ {t("extensions.hostError")}
        </button>
      )}
    </div>
  );
}
