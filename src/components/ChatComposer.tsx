import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerChip } from "./composerChips";
import { chipDisplayLabel } from "./composerChips";
import type { ChatAttachment, ChatMode } from "../services/tauri/chat";
import "./ChatComposer.css";

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

function ChipGlyph({ chip }: { chip: ComposerChip }) {
  switch (chip.kind) {
    case "browser-element":
      return <BrowserElementGlyph />;
    case "file-ref":
      return <FileRefGlyph isDir={chip.isDir} />;
    case "terminal-snippet":
      return <TerminalGlyph />;
    case "image-attachment":
      return null;
  }
}

function chipClassName(chip: ComposerChip): string {
  switch (chip.kind) {
    case "browser-element":
      return "codez-composer-chip-browser";
    case "file-ref":
      return "codez-composer-chip-file";
    case "terminal-snippet":
      return "codez-composer-chip-terminal";
    case "image-attachment":
      return "codez-composer-chip-image";
  }
}

function chipTitle(chip: ComposerChip): string | undefined {
  switch (chip.kind) {
    case "browser-element":
      return chip.element.selector;
    case "file-ref":
      return chip.path;
    case "terminal-snippet":
      return chip.preview;
    case "image-attachment":
      return chip.attachment.filename ?? chip.attachment.path ?? undefined;
  }
}

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

function SkillGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l2.4 6.9H22l-5.8 4.2 2.2 6.9L12 16l-6.4 4 2.2-6.9L2 8.9h7.6z" />
    </svg>
  );
}

export interface SkillSelector {
  options: ComposerMenuOption[];
  selected: string[];
  onChange: (slugs: string[]) => void;
  label: string;
  emptyHint?: string;
}

function SkillsMenu({ selector, disabled }: { selector: SkillSelector; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { options, selected, onChange, label, emptyHint } = selector;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const count = selected.length;
  return (
    <div className="codez-composer-menu text" ref={rootRef}>
      <button
        type="button"
        className={`codez-composer-menu-trigger${count > 0 ? " has-skills" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={label}
      >
        <span className="codez-composer-menu-icon">
          <SkillGlyph />
        </span>
        <span className="codez-composer-menu-label">{count > 0 ? `${label} · ${count}` : label}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="codez-composer-menu-popup" role="listbox" aria-multiselectable="true">
          {options.length === 0 ? (
            <div className="codez-composer-menu-empty">{emptyHint ?? "—"}</div>
          ) : (
            options.map((opt) => {
              const active = selected.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`codez-skill-option${active ? " active" : ""}`}
                  onClick={() => toggle(opt.id)}
                >
                  <span className="codez-skill-option-head">
                    <span className="codez-composer-menu-check" aria-hidden>
                      {active ? "✓" : ""}
                    </span>
                    <span className="codez-composer-menu-option-label">{opt.label}</span>
                  </span>
                  {opt.hint && <span className="codez-composer-menu-option-hint">{opt.hint}</span>}
                </button>
              );
            })
          )}
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
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
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
  /** Optional multi-select of installed skills to enable for the conversation. */
  skillSelector?: SkillSelector;
  /** Optional single-select of an installed agent persona to run as. */
  agentSelector?: {
    value: string;
    options: ComposerMenuOption[];
    onChange: (id: string) => void;
  };
  modeNotice?: string | null;
  mentionPopup?: ReactNode;
  composerClassName?: string;
  /** Non-editable chips (e.g. picked browser elements) shown above the textarea. */
  chips?: ComposerChip[];
  onRemoveChip?: (id: string) => void;
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
  onPaste,
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
  skillSelector,
  agentSelector,
  modeNotice,
  mentionPopup,
  composerClassName = "",
  chips = [],
  onRemoveChip,
  inputDisabled = false,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const canSend = canSendProp ?? Boolean(value.trim() || attachment || chips.length > 0);
  const locked = inputDisabled && !busy;

  return (
    <div className="codez-composer-wrap">
      {modeNotice && <div className="codez-mode-notice">{modeNotice}</div>}
      <div
        className={`codez-composer${modeSelector?.chatMode === "plan" ? " is-plan" : ""}${busy ? " is-busy" : ""}${composerClassName ? ` ${composerClassName}` : ""}`}
      >
        {chips.length > 0 && (
          <div className="codez-composer-chips">
            {chips.map((chip) =>
              chip.kind === "image-attachment" ? (
                <span
                  key={chip.id}
                  className={`codez-composer-chip ${chipClassName(chip)}`}
                  title={chipTitle(chip) ?? chipDisplayLabel(chip, t)}
                >
                  <img src={chip.preview} alt="" className="codez-composer-chip-thumb" />
                  <span className="codez-composer-chip-label">{chipDisplayLabel(chip, t)}</span>
                  {onRemoveChip && !busy && !locked && (
                    <button
                      type="button"
                      className="codez-composer-chip-remove"
                      onClick={() => onRemoveChip(chip.id)}
                      aria-label={t("chat.removeChip")}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ) : (
                <span
                  key={chip.id}
                  className={`codez-composer-chip ${chipClassName(chip)}`}
                  title={chipTitle(chip)}
                >
                  <ChipGlyph chip={chip} />
                  <span className="codez-composer-chip-label">{chipDisplayLabel(chip, t)}</span>
                  {onRemoveChip && !busy && !locked && (
                    <button
                      type="button"
                      className="codez-composer-chip-remove"
                      onClick={() => onRemoveChip(chip.id)}
                      aria-label={t("chat.removeChip")}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ),
            )}
          </div>
        )}

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
          onPaste={onPaste}
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
            {agentSelector && agentSelector.options.length > 1 && (
              <ComposerMenu
                value={agentSelector.value}
                options={agentSelector.options}
                onChange={agentSelector.onChange}
                variant="text"
                disabled={busy || locked}
              />
            )}
            {skillSelector && <SkillsMenu selector={skillSelector} disabled={busy || locked} />}
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
