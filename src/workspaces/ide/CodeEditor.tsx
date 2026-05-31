import { useRef, useEffect, useCallback, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import type { OpenTab } from "./types";
import {
  lspApi,
  languageForFile,
  LspClient,
  registerLspProviders,
  type LspProvidersRegistration,
} from "../../services/tauri/lsp";
import { inlineEdit } from "../../services/tauri/edit";
import "./InlineEdit.css";

interface InlineEditState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  range: any;
  original: string;
  before: string;
  after: string;
  instruction: string;
  proposed: string | null;
  busy: boolean;
  error: string | null;
}

interface CodeEditorProps {
  tab: OpenTab;
  theme: string;
  projectDir: string | null;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export default function CodeEditor({ tab, theme, projectDir, onChange, onSave }: CodeEditorProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const lspRef = useRef<LspProvidersRegistration | null>(null);
  const [inline, setInline] = useState<InlineEditState | null>(null);
  const inlineStateRef = useRef<InlineEditState | null>(null);
  inlineStateRef.current = inline;

  // Open the Cmd-K inline-edit widget for the current selection (or line).
  const openInlineRef = useRef<() => void>(() => {});
  openInlineRef.current = () => {
    const editor = editorRef.current;
    if (!editor || tab.isReadOnly) return;
    const model = editor.getModel?.();
    if (!model) return;
    let sel = editor.getSelection?.();
    if (!sel) return;
    if (sel.isEmpty?.()) {
      // Expand an empty selection to the whole current line.
      const ln = sel.startLineNumber;
      sel = {
        startLineNumber: ln,
        startColumn: 1,
        endLineNumber: ln,
        endColumn: model.getLineMaxColumn(ln),
      };
    }
    const original = model.getValueInRange(sel);
    const totalLines = model.getLineCount();
    const beforeStart = Math.max(1, sel.startLineNumber - 40);
    const afterEnd = Math.min(totalLines, sel.endLineNumber + 40);
    const before =
      sel.startLineNumber > 1
        ? model.getValueInRange({
            startLineNumber: beforeStart,
            startColumn: 1,
            endLineNumber: sel.startLineNumber,
            endColumn: 1,
          })
        : "";
    const after =
      sel.endLineNumber < totalLines
        ? model.getValueInRange({
            startLineNumber: sel.endLineNumber,
            startColumn: model.getLineMaxColumn(sel.endLineNumber),
            endLineNumber: afterEnd,
            endColumn: model.getLineMaxColumn(afterEnd),
          })
        : "";
    setInline({
      range: sel,
      original,
      before,
      after,
      instruction: "",
      proposed: null,
      busy: false,
      error: null,
    });
  };

  const runInline = useCallback(async () => {
    const s = inlineStateRef.current;
    if (!s || !s.instruction.trim() || s.busy) return;
    setInline((cur) => (cur ? { ...cur, busy: true, error: null } : cur));
    try {
      const proposed = await inlineEdit({
        instruction: s.instruction,
        selection: s.original,
        language: tab.language || languageForFile(tab.path),
        beforeContext: s.before,
        afterContext: s.after,
      });
      setInline((cur) => (cur ? { ...cur, proposed, busy: false } : cur));
    } catch (e) {
      setInline((cur) => (cur ? { ...cur, busy: false, error: String(e) } : cur));
    }
  }, [tab.language, tab.path]);

  const acceptInline = useCallback(() => {
    setInline((cur) => {
      if (cur && cur.proposed != null && editorRef.current) {
        editorRef.current.executeEdits("codez-inline-edit", [
          { range: cur.range, text: cur.proposed },
        ]);
      }
      return null;
    });
  }, []);

  // Track the content currently in the editor so we can distinguish:
  //   * Monaco's `onChange` firing during initial `value` hydration / tab
  //     switches (same content → must NOT mark dirty)
  //   * A genuine user keystroke (different content → mark dirty)
  //
  // Without this, opening the 2nd/3rd file triggered a spurious dirty dot
  // because Monaco re-emits onChange with the same content after the parent
  // re-renders the <Editor> with a new `value` prop.
  const lastContentRef = useRef<string>(tab.content);

  // Update lastContentRef synchronously when the tab changes, BEFORE
  // Monaco's onChange fires during the render pass. The useEffect below
  // also sets it (for safety), but that runs AFTER render — too late,
  // because @monaco-editor/react's internal model update + onChange
  // callback happen during the React commit phase.
  const lastPathRef = useRef<string>(tab.path);
  if (tab.path !== lastPathRef.current) {
    // Different file entirely — reset tracked content so the next
    // onChange (which fires with the new file's content during Monaco
    // hydration) does NOT mark the tab dirty.
    lastContentRef.current = tab.content;
    lastPathRef.current = tab.path;
  }

  // Stable ref for the latest onSave callback so Monaco's Ctrl+S command
  // does not need to be re-registered every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Stable ref for the latest onChange callback so the Monaco command
  // closure always sees the current callback without being recreated.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // Add Ctrl+S / Cmd+S save shortcut — delegates to the parent's onSave
      // so the actual disk write (ideApi.writeFile) runs from the IDE layer
      // where tab state + project dir live.
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
        () => {
          onSaveRef.current?.();
        },
      );

      // Cmd-K / Ctrl-K — open the inline edit widget for the selection.
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        2048 | 41, // KeyMod.CtrlCmd | KeyCode.KeyK
        () => {
          openInlineRef.current();
        },
      );

      // ── LSP integration ────────────────────────────────────────────
      const lang = tab.language || languageForFile(tab.path);
      const fullPath = projectDir ? `${projectDir}/${tab.path}` : tab.path;

      if (lang && projectDir) {
        // Clean up previous LSP connection
        lspRef.current?.dispose();
        lspRef.current = null;

        lspApi
          .start(projectDir, lang)
          .then(async (port) => {
            const client = new LspClient(port);
            try {
              await client.connect(
                projectDir,
                lang,
                fullPath,
                tab.content,
              );
              const reg = registerLspProviders(monaco, client, fullPath);
              lspRef.current = reg;

              // Trigger initial diagnostics
              client.requestDiagnostics(fullPath);
            } catch (e) {
              console.warn("[LSP] Failed to connect:", e);
            }
          })
          .catch((e) => {
            // LSP server may not be available — that's fine
            console.debug("[LSP] Server not available for", lang, ":", e);
          });
      }
    },
    [tab.path, tab.language, tab.content, projectDir],
  );

  useEffect(() => {
    // Update editor content when tab changes.
    // Monaco's `value` prop handles the initial set; calling setValue here
    // keeps the editor in sync when the user switches tabs (same editor
    // instance, different content). Track the content so the next onChange
    // can distinguish user edits from Monaco re-echoing the value.
    const editor = editorRef.current as { setValue?: (v: string) => void } | null;
    if (editor && typeof editor.setValue === "function") {
      editor.setValue(tab.content);
    }
    lastContentRef.current = tab.content;

    // Cleanup LSP on unmount
    return () => {
      lspRef.current?.dispose();
      lspRef.current = null;
    };
  }, [tab.path, tab.content]);

  if (tab.isDiff && tab.originalContent !== undefined) {
    return (
      <DiffEditor
        height="100%"
        theme="vs-dark"
        language={tab.language || "plaintext"}
        original={tab.originalContent}
        modified={tab.content}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'Consolas, "Courier New", monospace',
          scrollBeyondLastLine: false,
        }}
      />
    );
  }

  return (
    <div className="codez-editor-wrap">
      <Editor
        height="100%"
        theme={theme === "gold" ? "vs-dark" : "vs-dark"}
        language={tab.language || "plaintext"}
        value={tab.content}
        onChange={(v) => {
          const next = v || "";
          // Only propagate to parent (which sets isDirty=true) when the
          // new content actually differs from what we last pushed in.
          // Monaco fires onChange with the same content during initial
          // hydration and after setValue() — those must be ignored or
          // switching tabs would show a spurious dirty dot.
          if (next !== lastContentRef.current) {
            lastContentRef.current = next;
            onChangeRef.current(next);
          }
        }}
        onMount={handleMount}
        options={{
          readOnly: tab.isReadOnly,
          minimap: { enabled: true },
          fontSize: 13,
          fontFamily: 'Consolas, "Courier New", monospace',
          scrollBeyondLastLine: false,
          wordWrap: "on",
          lineNumbers: "on",
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          folding: true,
          automaticLayout: true,
          tabSize: 2,
        }}
      />

      {inline && (
        <div className="codez-inline-edit">
          <div className="codez-inline-edit-bar">
            <input
              autoFocus
              className="codez-inline-edit-input"
              placeholder="Edit instruction… (Enter to generate, Esc to cancel)"
              value={inline.instruction}
              onChange={(e) => setInline((cur) => (cur ? { ...cur, instruction: e.target.value } : cur))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runInline();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setInline(null);
                }
              }}
            />
            <button onClick={() => void runInline()} disabled={inline.busy || !inline.instruction.trim()}>
              {inline.busy ? "…" : "Generate"}
            </button>
            <button className="codez-inline-edit-cancel" onClick={() => setInline(null)}>
              Cancel
            </button>
          </div>
          {inline.error && <div className="codez-inline-edit-error">{inline.error}</div>}
          {inline.proposed != null && (
            <div className="codez-inline-edit-preview">
              <pre>{inline.proposed}</pre>
              <div className="codez-inline-edit-actions">
                <button className="codez-inline-accept" onClick={acceptInline}>
                  Accept
                </button>
                <button onClick={() => setInline((cur) => (cur ? { ...cur, proposed: null } : cur))}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
