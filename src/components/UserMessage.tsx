import { useTranslation } from "react-i18next";
import { parseUserMessageRefs } from "./chatFileRefs";
import { fileRefChipLabel } from "./composerChips";
import "./UserMessage.css";

function BrowserElementGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

function FileRefGlyph({ isDir }: { isDir: boolean }) {
  if (isDir) {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M12 15h5" />
    </svg>
  );
}

export default function UserMessage({ text }: { text: string }) {
  const { t } = useTranslation();
  const parts = parseUserMessageRefs(text);
  return (
    <div className="codez-msg-text codez-user-message">
      {parts.map((part, i) => {
        if (part.type === "ref") {
          return (
            <span key={`${part.path}-${i}`} className="codez-ref-chip" title={part.path}>
              <FileRefGlyph isDir={part.isDir} />
              <span>{fileRefChipLabel(part.path, part.isDir)}</span>
            </span>
          );
        }
        if (part.type === "browser-element") {
          return (
            <span
              key={`${part.selector}-${i}`}
              className="codez-browser-chip"
              title={part.selector}
            >
              <BrowserElementGlyph />
              <span>{part.label}</span>
            </span>
          );
        }
        if (part.type === "terminal-snippet") {
          return (
            <span
              key={`${part.snippetId}-${i}`}
              className="codez-terminal-chip"
              title={part.snippetId}
            >
              <TerminalGlyph />
              <span>{t("chat.chipTerminal")}</span>
            </span>
          );
        }
        return <span key={i}>{part.value}</span>;
      })}
    </div>
  );
}
