import { type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerChip } from "./composerChips";
import { chipDisplayLabel } from "./composerChips";
import type { ChatAttachment, ChatMode } from "../services/tauri/chat";
import DropdownSelect, { DropdownMultiSelect, type DropdownOption } from "./DropdownSelect";
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
      return "agentz-composer-chip-browser";
    case "file-ref":
      return "agentz-composer-chip-file";
    case "terminal-snippet":
      return "agentz-composer-chip-terminal";
    case "image-attachment":
      return "agentz-composer-chip-image";
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

export type ComposerMenuOption = DropdownOption;

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
  return <span className="agentz-mode-infinity">∞</span>;
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
    <div className="agentz-composer-wrap">
      {modeNotice && <div className="agentz-mode-notice">{modeNotice}</div>}
      <div
        className={`agentz-composer${modeSelector?.chatMode === "plan" ? " is-plan" : ""}${busy ? " is-busy" : ""}${composerClassName ? ` ${composerClassName}` : ""}`}
      >
        {chips.length > 0 && (
          <div className="agentz-composer-chips">
            {chips.map((chip) =>
              chip.kind === "image-attachment" ? (
                <span
                  key={chip.id}
                  className={`agentz-composer-chip ${chipClassName(chip)}`}
                  title={chipTitle(chip) ?? chipDisplayLabel(chip, t)}
                >
                  <img src={chip.preview} alt="" className="agentz-composer-chip-thumb" />
                  <span className="agentz-composer-chip-label">{chipDisplayLabel(chip, t)}</span>
                  {onRemoveChip && !busy && !locked && (
                    <button
                      type="button"
                      className="agentz-composer-chip-remove"
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
                  className={`agentz-composer-chip ${chipClassName(chip)}`}
                  title={chipTitle(chip)}
                >
                  <ChipGlyph chip={chip} />
                  <span className="agentz-composer-chip-label">{chipDisplayLabel(chip, t)}</span>
                  {onRemoveChip && !busy && !locked && (
                    <button
                      type="button"
                      className="agentz-composer-chip-remove"
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
          <div className="agentz-attachment-preview">
            {attachmentPreview ? (
              <img src={attachmentPreview} className="agentz-attachment-thumb" alt={attachment.filename ?? ""} />
            ) : (
              <span className="agentz-attachment-file-icon">📎</span>
            )}
            <span className="agentz-attachment-name" title={attachment.path ?? ""}>
              {attachment.filename ?? attachment.path}
            </span>
            <button
              type="button"
              className="agentz-attachment-remove"
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
          className="agentz-composer-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          disabled={busy || locked}
        />

        <div className="agentz-composer-footer">
          <div className="agentz-composer-footer-left">
            {modeSelector && (
              <DropdownSelect
                value={modeSelector.chatMode}
                options={modeSelector.options}
                onChange={(id) => modeSelector.onChange(id as ChatMode)}
                variant="pill"
                placement="up"
                icon={<ModeIcon mode={modeSelector.chatMode} />}
                disabled={busy || locked}
              />
            )}
            <DropdownSelect
              value={modelId}
              options={modelOptions}
              onChange={onModelChange}
              variant="text"
              placement="up"
              disabled={busy || locked}
            />
            {agentSelector && agentSelector.options.length > 1 && (
              <DropdownSelect
                value={agentSelector.value}
                options={agentSelector.options}
                onChange={agentSelector.onChange}
                variant="text"
                placement="up"
                disabled={busy || locked}
              />
            )}
            {skillSelector && (
              <DropdownMultiSelect
                options={skillSelector.options}
                selected={skillSelector.selected}
                onChange={skillSelector.onChange}
                label={skillSelector.label}
                emptyHint={skillSelector.emptyHint}
                icon={<SkillGlyph />}
                disabled={busy || locked}
              />
            )}
            <button
              type="button"
              className="agentz-composer-icon-btn"
              onClick={onAttach}
              disabled={busy || locked}
              title={attachTitle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          </div>
          <div className="agentz-composer-footer-right">
            {busy && <span className="agentz-composer-spinner" aria-hidden />}
            {busy ? (
              <button type="button" className="agentz-composer-stop-icon" onClick={onStop} title={stopTitle}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className={`agentz-composer-send-icon${canSend ? " ready" : ""}`}
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
