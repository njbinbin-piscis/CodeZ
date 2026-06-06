import { useTranslation } from "react-i18next";
import ExtensionsManager from "./ExtensionsManager";
import "./ExtensionsPanel.css";

interface ExtensionsPanelProps {
  onClose: () => void;
}

/** Standalone overlay wrapper around the reusable {@link ExtensionsManager}. */
export default function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const { t: tr } = useTranslation();

  return (
    <div className="agentz-ext-overlay" onClick={onClose}>
      <div className="agentz-ext-panel" onClick={(e) => e.stopPropagation()}>
        <div className="agentz-ext-header">
          <span>{tr("extensions.title")}</span>
          <button onClick={onClose} title={tr("common.close")}>
            ✕
          </button>
        </div>
        <ExtensionsManager />
      </div>
    </div>
  );
}
