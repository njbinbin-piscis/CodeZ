import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./TagMultiSelect.css";

export interface TagOption {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  values: string[];
  options: TagOption[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  /** Max rows shown in the dropdown before scrolling. */
  maxVisible?: number;
}

const DROPDOWN_CAP = 80;

export default function TagMultiSelect({
  values,
  options,
  onChange,
  placeholder,
  emptyText,
  maxVisible = 8,
}: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const optionMap = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => {
      if (values.includes(o.value)) return false;
      if (!q) return true;
      return (
        o.value.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        (o.hint?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [options, values, query]);

  const dropdownItems = available.slice(0, DROPDOWN_CAP);
  const truncated = available.length > DROPDOWN_CAP;

  const add = useCallback(
    (value: string) => {
      if (!values.includes(value)) onChange([...values, value]);
      setQuery("");
      setActiveIdx(0);
      inputRef.current?.focus();
    },
    [values, onChange],
  );

  const remove = useCallback(
    (value: string) => {
      onChange(values.filter((v) => v !== value));
    },
    [values, onChange],
  );

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, dropdownItems.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && open && dropdownItems.length > 0) {
      e.preventDefault();
      add(dropdownItems[activeIdx]?.value ?? dropdownItems[0].value);
      return;
    }
    if (e.key === "Backspace" && !query && values.length > 0) {
      remove(values[values.length - 1]);
    }
  };

  /** Min row height — must fit label + optional hint line. */
  const optionMinH = 52;
  const visibleRows = Math.max(1, Math.min(maxVisible, dropdownItems.length || 1));
  const listMaxH = visibleRows * optionMinH;

  return (
    <div
      ref={rootRef}
      className={`agentz-tag-ms${open ? " open" : ""}`}
      onClick={() => {
        setOpen(true);
        inputRef.current?.focus();
      }}
    >
      <div className="agentz-tag-ms-chips">
        {values.map((v) => {
          const opt = optionMap.get(v);
          return (
            <span key={v} className="agentz-tag-ms-chip" title={opt?.hint ?? v}>
              <span className="agentz-tag-ms-chip-label">{opt?.label ?? v}</span>
              <button
                type="button"
                className="agentz-tag-ms-chip-x"
                aria-label={t("tagMultiSelect.remove", { item: opt?.label ?? v })}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(v);
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="agentz-tag-ms-input"
          value={query}
          placeholder={values.length === 0 ? placeholder : ""}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-controls={listId}
        />
      </div>

      {open && (
        <ul
          id={listId}
          className="agentz-tag-ms-dropdown"
          role="listbox"
          style={{ maxHeight: listMaxH, minHeight: optionMinH }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {dropdownItems.length === 0 ? (
            <li className="agentz-tag-ms-empty">
              {emptyText ?? t("tagMultiSelect.noMatch")}
            </li>
          ) : (
            dropdownItems.map((o, i) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`agentz-tag-ms-option${i === activeIdx ? " active" : ""}`}
                  onClick={() => add(o.value)}
                >
                  <span className="agentz-tag-ms-option-label">{o.label}</span>
                  {o.hint && <span className="agentz-tag-ms-option-hint">{o.hint}</span>}
                </button>
              </li>
            ))
          )}
          {truncated && (
            <li className="agentz-tag-ms-more">
              {t("tagMultiSelect.moreResults", { count: available.length - DROPDOWN_CAP })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
