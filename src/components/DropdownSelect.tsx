import { useEffect, useRef, useState, type ReactNode } from "react";
import "./DropdownSelect.css";

export interface DropdownOption {
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

export interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  variant?: "pill" | "text" | "field" | "inline";
  placement?: "up" | "down";
  disabled?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  title?: string;
  /** Optional icon before the label (pill/text variants). */
  icon?: ReactNode;
  /** Highlight trigger when a non-empty value is selected. */
  accentWhenSet?: boolean;
}

/** Theme-aware single-select menu (replaces native `<select>` popup styling). */
export default function DropdownSelect({
  value,
  options,
  onChange,
  variant = "field",
  placement,
  disabled,
  id,
  className,
  placeholder,
  title,
  icon,
  accentWhenSet,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const resolvedPlacement = placement ?? (variant === "pill" || variant === "text" ? "up" : "down");
  const selected = options.find((o) => o.id === value);
  const displayLabel = selected?.label ?? placeholder ?? options[0]?.label ?? "—";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const popupClass = resolvedPlacement === "up" ? "popup-up" : "popup-down";

  return (
    <div
      className={`agentz-dropdown ${variant} ${popupClass}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        id={id}
        className={`agentz-dropdown-trigger${accentWhenSet && value ? " has-value-accent" : ""}`}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon && <span className="agentz-dropdown-icon">{icon}</span>}
        <span className="agentz-dropdown-label">{displayLabel}</span>
        {(variant === "pill" || variant === "text") && (
          <span className="agentz-dropdown-chevron">
            <ChevronDown />
          </span>
        )}
      </button>
      {open && (
        <div className="agentz-dropdown-popup" role="listbox">
          {options.length === 0 ? (
            <div className="agentz-dropdown-empty">{placeholder ?? "—"}</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.id || "__empty"}
                type="button"
                role="option"
                aria-selected={opt.id === value}
                className={opt.id === value ? "active" : ""}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                <span className="agentz-dropdown-option-label">{opt.label}</span>
                {opt.hint && <span className="agentz-dropdown-option-hint">{opt.hint}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export interface DropdownMultiSelectProps {
  options: DropdownOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  label: string;
  disabled?: boolean;
  emptyHint?: string;
  onEmptyHintClick?: () => void;
  /** When "toast", hints are not rendered inline — use onHintToast (e.g. on hover). */
  hintPresentation?: "inline" | "toast";
  onHintToast?: (message: string) => void;
}

/** Multi-select skills-style menu (CodeZ composer). */
export function DropdownMultiSelect({
  options,
  selected,
  onChange,
  label,
  disabled,
  emptyHint,
  onEmptyHintClick,
  hintPresentation = "inline",
  onHintToast,
  icon,
}: DropdownMultiSelectProps & { icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    <div className="agentz-dropdown text popup-up" ref={rootRef}>
      <button
        type="button"
        className={`agentz-dropdown-trigger${count > 0 ? " has-value-accent" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {icon && <span className="agentz-dropdown-icon">{icon}</span>}
        <span className="agentz-dropdown-label">{count > 0 ? `${label} · ${count}` : label}</span>
        <span className="agentz-dropdown-chevron">
          <ChevronDown />
        </span>
      </button>
      {open && (
        <div className="agentz-dropdown-popup" role="listbox" aria-multiselectable="true">
          {options.length === 0 ? (
            onEmptyHintClick ? (
              <button type="button" className="agentz-dropdown-empty agentz-dropdown-empty-action" onClick={onEmptyHintClick}>
                {emptyHint ?? "—"}
              </button>
            ) : (
              <div className="agentz-dropdown-empty">{emptyHint ?? "—"}</div>
            )
          ) : (
            options.map((opt) => {
              const active = selected.includes(opt.id);
              const showInlineHint = hintPresentation === "inline";
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={active ? "active" : ""}
                  onClick={() => toggle(opt.id)}
                  onPointerEnter={() => {
                    const hint = opt.hint?.trim();
                    if (hintPresentation === "toast" && hint && onHintToast) {
                      onHintToast(hint);
                    }
                  }}
                >
                  <span className="agentz-dropdown-option-head">
                    <span className="agentz-dropdown-check" aria-hidden>
                      {active ? "✓" : ""}
                    </span>
                    <span className="agentz-dropdown-option-label">{opt.label}</span>
                  </span>
                  {showInlineHint && opt.hint && (
                    <span className="agentz-dropdown-option-hint">{opt.hint}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
