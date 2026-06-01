import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatAttachment, ChatMode } from "../services/tauri/chat";
import "./ChatComposer.css";

export interface ComposerMenuOption {
  id: string;
  label: string;
  hint?: string;
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: ChatMode }) {
  if (mode === "plan") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <rect x="9" y="3" width="6" height="4" rx="1" />
        <path d="M9 12h6M9 16h6" />
      </svg>
    );
  }
  return <span className="codez-mode-infinity">∞</span>;
}

function ComposerMenu({
  value,
  options,
  onChange,
  variant,
  modeIcon,
  disabled,
}: {
  value: string;
  options: ComposerMenuOption[];
  onChange: (id: string) => void;
  variant: "pill" | "text";
  modeIcon?: ChatMode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className={`codez-composer-menu ${variant}`} ref={rootRef}>
      <button
        type="button"
        className="codez-composer-menu-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {variant === "pill" && modeIcon && (
          <span className="codez-composer-menu-icon">
            <ModeIcon mode={modeIcon} />
          </span>
        )}
        <span className="codez-composer-menu-label">{selected?.label}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="codez-composer-menu-popup" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.id || "__default"}
              type="button"
              role="option"
              aria-selected={opt.id === value}
              className={opt.id === value ? "active" : ""}
              onClick={() => {
                onChange(opt.id);
                setOpen(false);
              }}
            >
              <span className="codez-composer-menu-option-label">{opt.label}</span>
              {opt.hint && <span className="codez-composer-menu-option-hint">{opt.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string, caret?: number) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder: string;
  canSend?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  modelId: string;
  modelOptions: ComposerMenuOption[];
  onModelChange: (id: string) => void;
  attachment: ChatAttachment | null;
  attachmentPreview: string | null;
  onAttach: () => void;
  onClearAttachment: () => void;
  attachTitle?: string;
  removeAttachmentTitle?: string;
  stopTitle?: string;
  sendTitle?: string;
  modeSelector?: {
    chatMode: ChatMode;
    options: ComposerMenuOption[];
    onChange: (mode: ChatMode) => void;
  };
  modeNotice?: string | null;
  mentionPopup?: ReactNode;
  composerClassName?: string;
  /** When true, lock input controls (e.g. no project folder open). */
  inputDisabled?: boolean;
}

export default function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  placeholder,
  canSend: canSendProp,
  textareaRef,
  onKeyDown,
  modelId,
  modelOptions,
  onModelChange,
  attachment,
  attachmentPreview,
  onAttach,
  onClearAttachment,
  attachTitle = "Attach file",
  removeAttachmentTitle = "Remove attachment",
  stopTitle = "Stop",
  sendTitle = "Send",
  modeSelector,
  modeNotice,
  mentionPopup,
  composerClassName = "",
  inputDisabled = false,
}: ChatComposerProps) {
  const canSend = canSendProp ?? Boolean(value.trim() || attachment);
  const locked = inputDisabled && !busy;

  return (
    <div className="codez-composer-wrap">
      {modeNotice && <div className="codez-mode-notice">{modeNotice}</div>}
      <div
        className={`codez-composer${modeSelector?.chatMode === "plan" ? " is-plan" : ""}${busy ? " is-busy" : ""}${composerClassName ? ` ${composerClassName}` : ""}`}
      >
        {attachment && (
          <div className="codez-attachment-preview">
            {attachmentPreview ? (
              <img src={attachmentPreview} className="codez-attachment-thumb" alt={attachment.filename ?? ""} />
            ) : (
              <span className="codez-attachment-file-icon">📎</span>
            )}
            <span className="codez-attachment-name" title={attachment.path ?? ""}>
              {attachment.filename ?? attachment.path}
            </span>
            <button
              type="button"
              className="codez-attachment-remove"
              onClick={onClearAttachment}
              title={removeAttachmentTitle}
            >
              ✕
            </button>
          </div>
        )}

        {mentionPopup}

        <textarea
          ref={textareaRef}
          className="codez-composer-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={busy || locked}
        />

        <div className="codez-composer-footer">
          <div className="codez-composer-footer-left">
            {modeSelector && (
              <ComposerMenu
                value={modeSelector.chatMode}
                options={modeSelector.options}
                onChange={(id) => modeSelector.onChange(id as ChatMode)}
                variant="pill"
                modeIcon={modeSelector.chatMode}
                disabled={busy || locked}
              />
            )}
            <ComposerMenu
              value={modelId}
              options={modelOptions}
              onChange={onModelChange}
              variant="text"
              disabled={busy || locked}
            />
            <button
              type="button"
              className="codez-composer-icon-btn"
              onClick={onAttach}
              disabled={busy || locked}
              title={attachTitle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          </div>
          <div className="codez-composer-footer-right">
            {busy && <span className="codez-composer-spinner" aria-hidden />}
            {busy ? (
              <button type="button" className="codez-composer-stop-icon" onClick={onStop} title={stopTitle}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className={`codez-composer-send-icon${canSend ? " ready" : ""}`}
                onClick={onSubmit}
                disabled={!canSend || locked}
                title={sendTitle}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
