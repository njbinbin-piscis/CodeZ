import { useMemo, useState } from "react";
import { buildDiffPreview } from "../utils/diffPreview";
import "./FileDiffCard.css";

export interface FileDiffData {
  id: number;
  rel_path: string;
  existed: boolean;
  before: string | null;
  after: string;
}

interface FileDiffCardProps {
  diff: FileDiffData;
  onOpen?: (path: string) => void;
}

export default function FileDiffCard({ diff, onOpen }: FileDiffCardProps) {
  const [expanded, setExpanded] = useState(true);
  const preview = useMemo(
    () => buildDiffPreview(diff.before, diff.after),
    [diff.before, diff.after],
  );
  const tag = diff.existed ? "M" : "A";

  return (
    <div className="agentz-file-diff-card">
      <button
        type="button"
        className="agentz-file-diff-head"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`agentz-file-diff-tag ${diff.existed ? "mod" : "new"}`}>{tag}</span>
        <span className="agentz-file-diff-path" title={diff.rel_path}>
          {diff.rel_path}
        </span>
        <span className="agentz-file-diff-stats">
          {preview.additions > 0 && <span className="add">+{preview.additions}</span>}
          {preview.deletions > 0 && <span className="del">-{preview.deletions}</span>}
        </span>
        <span className="agentz-file-diff-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && preview.lines.length > 0 && (
        <pre className="agentz-file-diff-body">
          {preview.lines.map((line, i) => (
            <div key={i} className={`agentz-file-diff-line ${line.kind}`}>
              <span className="agentz-file-diff-gutter">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              <span>{line.text || " "}</span>
            </div>
          ))}
        </pre>
      )}
      {onOpen && (
        <button
          type="button"
          className="agentz-file-diff-open"
          onClick={() => onOpen(diff.rel_path)}
        >
          Open
        </button>
      )}
    </div>
  );
}
