import { useEffect, useRef, useState } from "react";
import { useExtensionUi } from "./useExtensionUi";

/** Renders vscode.window.showQuickPick / showInputBox overlays. */
export default function QuickInput() {
  const { quickPick, inputBox } = useExtensionUi();
  const [filter, setFilter] = useState("");
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFilter("");
    setChecked(new Set());
    inputRef.current?.focus();
  }, [quickPick?.id]);
  useEffect(() => {
    setText(inputBox?.value ?? "");
    inputRef.current?.focus();
  }, [inputBox?.id]);

  if (!quickPick && !inputBox) return null;

  if (inputBox) {
    return (
      <div className="codez-quick-overlay" onClick={() => inputBox.resolve(undefined)}>
        <div className="codez-quick" onClick={(e) => e.stopPropagation()}>
          {inputBox.prompt && <div className="codez-quick-prompt">{inputBox.prompt}</div>}
          <input
            ref={inputRef}
            type={inputBox.password ? "password" : "text"}
            placeholder={inputBox.placeHolder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") inputBox.resolve(text);
              else if (e.key === "Escape") inputBox.resolve(undefined);
            }}
          />
        </div>
      </div>
    );
  }

  const qp = quickPick!;
  const items = qp.items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.label.toLowerCase().includes(filter.toLowerCase()));

  const accept = () => {
    if (qp.canPickMany) {
      qp.resolve(qp.items.filter((_, i) => checked.has(i)));
    }
  };

  return (
    <div className="codez-quick-overlay" onClick={() => qp.resolve(undefined)}>
      <div className="codez-quick" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          placeholder={qp.placeHolder ?? "Type to filter…"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") qp.resolve(undefined);
            else if (e.key === "Enter" && qp.canPickMany) accept();
          }}
        />
        <div className="codez-quick-list">
          {items.map(({ it, idx }) => (
            <button
              key={idx}
              className="codez-quick-item"
              onClick={() => {
                if (qp.canPickMany) {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(idx)) next.delete(idx);
                    else next.add(idx);
                    return next;
                  });
                } else {
                  qp.resolve(it);
                }
              }}
            >
              {qp.canPickMany && <span className="codez-quick-check">{checked.has(idx) ? "☑" : "☐"}</span>}
              <span className="codez-quick-label">{it.label}</span>
              {it.description && <span className="codez-quick-desc">{it.description}</span>}
            </button>
          ))}
          {items.length === 0 && <div className="codez-quick-empty">No matching items</div>}
        </div>
        {qp.canPickMany && (
          <div className="codez-quick-footer">
            <button onClick={accept}>OK ({checked.size})</button>
          </div>
        )}
      </div>
    </div>
  );
}
