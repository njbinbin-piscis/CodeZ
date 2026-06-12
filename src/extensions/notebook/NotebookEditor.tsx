import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as monaco from "monaco-editor";
import { parseIpynb, serializeIpynb, emptyCell, type NbCell } from "./ipynb";
import { extensionService } from "../extensionService";
import MarkdownPreview from "../../workspaces/codez/MarkdownPreview";
import { themeStore } from "../../workspaces/codez/themeStore";
import "./notebook.css";

interface NotebookEditorProps {
  content: string;
  /** Called with the re-serialized .ipynb whenever cells change. */
  onChange: (value: string) => void;
}

/** A code cell backed by a real Monaco editor instance. */
function CodeCell({ cell, onSource }: { cell: NbCell; onSource: (v: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorTheme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value: cell.source,
      language: cell.language,
      theme: editorTheme,
      minimap: { enabled: false },
      lineNumbers: "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      folding: false,
      fontSize: 13,
      padding: { top: 6, bottom: 6 },
      scrollbar: { alwaysConsumeMouseWheel: false },
    });
    editorRef.current = editor;
    const resize = () => {
      const h = Math.min(Math.max(editor.getContentHeight(), 32), 600);
      if (hostRef.current) hostRef.current.style.height = `${h}px`;
      editor.layout();
    };
    resize();
    const cs = editor.onDidContentSizeChange(resize);
    const ch = editor.onDidChangeModelContent(() => onSource(editor.getValue()));
    return () => {
      cs.dispose();
      ch.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(editorTheme);
  }, [editorTheme]);

  return <div className="agentz-nb-code" ref={hostRef} />;
}

/** A markdown cell: edit mode (textarea) toggled with rendered preview. */
function MarkdownCell({ cell, onSource }: { cell: NbCell; onSource: (v: string) => void }) {
  const [editing, setEditing] = useState(cell.source.trim() === "");
  if (editing) {
    return (
      <textarea
        className="agentz-nb-md-edit"
        value={cell.source}
        autoFocus
        onChange={(e) => onSource(e.target.value)}
        onBlur={() => setEditing(false)}
        placeholder="Markdown…"
      />
    );
  }
  return (
    <div className="agentz-nb-md-view" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
      <MarkdownPreview content={cell.source || "*Empty markdown cell*"} />
    </div>
  );
}

export default function NotebookEditor({ content, onChange }: NotebookEditorProps) {
  const parsed = useMemo(() => parseIpynb(content), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [cells, setCells] = useState<NbCell[]>(parsed.cells);
  const language = parsed.language;

  // If an extension registered a serializer for a notebook type, try it for a
  // richer initial parse (e.g. non-ipynb notebook formats).
  useEffect(() => {
    if (cells.length > 0) return;
    const types = extensionService.notebookViewTypes();
    if (!extensionService.isRunning || types.length === 0) return;
    let cancelled = false;
    void extensionService
      .deserializeNotebook(types[0], content)
      .then((doc) => {
        if (cancelled) return;
        setCells(
          doc.cells.map((c, i) => ({
            id: `ext-${i}`,
            kind: c.kind === 1 ? 1 : 2,
            language: c.language || language,
            source: c.source,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (next: NbCell[]) => {
    setCells(next);
    onChange(serializeIpynb(next, language));
  };

  const updateSource = (id: string, source: string) => {
    commit(cells.map((c) => (c.id === id ? { ...c, source } : c)));
  };
  const addCell = (kind: 1 | 2, afterIndex: number) => {
    const next = [...cells];
    next.splice(afterIndex + 1, 0, emptyCell(kind, language));
    commit(next);
  };
  const deleteCell = (id: string) => commit(cells.filter((c) => c.id !== id));
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= cells.length) return;
    const next = [...cells];
    [next[index], next[j]] = [next[j], next[index]];
    commit(next);
  };

  return (
    <div className="agentz-nb">
      <div className="agentz-nb-toolbar">
        <button onClick={() => addCell(2, cells.length - 1)}>+ Code</button>
        <button onClick={() => addCell(1, cells.length - 1)}>+ Markdown</button>
        <span className="agentz-nb-lang">{language}</span>
      </div>
      <div className="agentz-nb-cells">
        {cells.length === 0 && <div className="agentz-nb-empty">Empty notebook. Add a cell to begin.</div>}
        {cells.map((cell, i) => (
          <div key={cell.id} className={`agentz-nb-cell ${cell.kind === 2 ? "code" : "markup"}`}>
            <div className="agentz-nb-cell-rail">
              <span className="agentz-nb-cell-kind">{cell.kind === 2 ? "[ ]" : "md"}</span>
              <button title="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button title="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              <button title="Delete" onClick={() => deleteCell(cell.id)}>
                ✕
              </button>
            </div>
            <div className="agentz-nb-cell-body">
              {cell.kind === 2 ? (
                <CodeCell cell={cell} onSource={(v) => updateSource(cell.id, v)} />
              ) : (
                <MarkdownCell cell={cell} onSource={(v) => updateSource(cell.id, v)} />
              )}
              {cell.outputs && cell.outputs.length > 0 && (
                <pre className="agentz-nb-output">{cell.outputs.join("\n")}</pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
