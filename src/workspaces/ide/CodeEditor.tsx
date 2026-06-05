import { useRef, useEffect, useCallback, useState, useSyncExternalStore } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { themeStore } from "./themeStore";
import type { OpenTab } from "./types";
import {
  lspApi,
  languageForFile,
  LspClient,
  registerLspProviders,
  type LspProvidersRegistration,
} from "../../services/tauri/lsp";
import { inlineEdit, aiInlineCompletion } from "../../services/tauri/edit";
import { diffLines } from "./lineDiff";
import { editorApplyBus } from "./editorApplyBus";
import { registerPersistedSnippets } from "./extensionStore";
import { attachBreakpointGutter } from "../../extensions/debug/breakpoints";
import "./InlineEdit.css";

/** localStorage flag gating AI Tab (ghost-text) completion. */
function tabCompleteEnabled(): boolean {
  return localStorage.getItem("codez-tab-complete") !== "0";
}

function completionModelId(): string | null {
  const id = localStorage.getItem("codez-completion-model-id");
  return id && id.trim() ? id : null;
}

/** Guard so the inline-completion provider is only registered once globally. */
let inlineCompletionRegistered = false;

/** Guard so persisted .vsix snippet providers are only registered once. */
let persistedSnippetsRegistered = false;

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
  /// Set once the proposal is applied in-place for preview (green range).
  applied: { startLine: number; endLine: number } | null;
}

interface CodeEditorProps {
  tab: OpenTab;
  theme: string;
  projectDir: string | null;
  onChange: (value: string) => void;
  onSave?: () => void;
  /// When set (and matching this tab), move the cursor to line/column and
  /// reveal it. `nonce` forces re-reveal even for the same line.
  reveal?: { line: number; column: number; nonce: number } | null;
}

export default function CodeEditor({ tab, projectDir, onChange, onSave, reveal }: CodeEditorProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const lspRef = useRef<LspProvidersRegistration | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bpDisposeRef = useRef<any>(null);
  const [inline, setInline] = useState<InlineEditState | null>(null);
  const inlineStateRef = useRef<InlineEditState | null>(null);
  inlineStateRef.current = inline;
  const editorTheme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot);

  // Move the cursor to a target line/column and center it (used by Search
  // "go to result" and other navigation). Reads the latest `reveal` via a ref.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const applyReveal = useCallback(() => {
    const editor = editorRef.current;
    const r = revealRef.current;
    if (!editor || !r) return;
    const line = Math.max(1, r.line || 1);
    const column = Math.max(1, r.column || 1);
    editor.revealLineInCenter?.(line);
    editor.setPosition?.({ lineNumber: line, column });
    editor.focus?.();
  }, []);

  useEffect(() => {
    if (reveal) applyReveal();
  }, [reveal, applyReveal]);

  // Monaco decorations (green "added" lines) + view zone (red "removed" block)
  // backing the in-editor inline diff preview.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoRef = useRef<any>(null);
  const viewZoneIdRef = useRef<string | null>(null);

  const clearInlinePreview = useCallback(() => {
    const editor = editorRef.current;
    decoRef.current?.clear?.();
    decoRef.current = null;
    if (editor && viewZoneIdRef.current) {
      const id = viewZoneIdRef.current;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.changeViewZones((acc: any) => acc.removeZone(id));
      viewZoneIdRef.current = null;
    }
  }, []);

  // Open the Cmd-K inline-edit widget for the current selection (or line).
  const openInlineRef = useRef<() => void>(() => {});
  openInlineRef.current = () => {
    const editor = editorRef.current;
    if (!editor || tab.isReadOnly) return;
    const model = editor.getModel?.();
    if (!model) return;
    if (inlineStateRef.current) clearInlinePreview();
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
      applied: null,
    });
  };

  // Apply the proposal in-place and render the inline diff: green decorations
  // over the new lines + a red view zone above showing the replaced original.
  const applyInlinePreview = useCallback((s: InlineEditState, proposed: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model) return null;

    editor.executeEdits("codez-inline-edit", [{ range: s.range, text: proposed }]);

    const startLine: number = s.range.startLineNumber;
    const proposedLineCount = proposed.length === 0 ? 0 : proposed.split("\n").length;
    const endLine = startLine + proposedLineCount - 1;

    // Line-level diff so only changed lines are highlighted (not the whole
    // block): added lines get a green decoration in place; removed lines are
    // collected into the red view zone above.
    const origLines = s.original.length === 0 ? [] : s.original.split("\n");
    const newLines = proposed.length === 0 ? [] : proposed.split("\n");
    const ops = diffLines(origLines, newLines);

    const addedDecos = ops
      .filter((o) => o.type === "add")
      .map((o) => ({
        range: {
          startLineNumber: startLine + o.bIndex,
          startColumn: 1,
          endLineNumber: startLine + o.bIndex,
          endColumn: 1,
        },
        options: { isWholeLine: true, className: "codez-inline-added-line" },
      }));
    if (addedDecos.length > 0) {
      decoRef.current = editor.createDecorationsCollection(addedDecos);
    }

    // Red "removed" block: only the lines that were actually deleted/changed.
    const removed = ops.filter((o) => o.type === "remove").map((o) => o.text);
    if (removed.length > 0) {
      const dom = document.createElement("div");
      dom.className = "codez-inline-removed-zone";
      dom.textContent = removed.join("\n");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.changeViewZones((acc: any) => {
        viewZoneIdRef.current = acc.addZone({
          afterLineNumber: Math.max(0, startLine - 1),
          heightInLines: removed.length,
          domNode: dom,
        });
      });
    }

    editor.revealLineInCenter?.(startLine);
    return { startLine, endLine };
  }, []);

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
      const fresh = inlineStateRef.current;
      if (!fresh) return; // cancelled while generating
      const applied = applyInlinePreview(fresh, proposed);
      setInline((cur) => (cur ? { ...cur, proposed, busy: false, applied } : cur));
    } catch (e) {
      setInline((cur) => (cur ? { ...cur, busy: false, error: String(e) } : cur));
    }
  }, [tab.language, tab.path, applyInlinePreview]);

  // Chat "Apply": replace the whole buffer with a proposed code block and show
  // the same inline diff preview (green added / red removed) so the user can
  // accept (Enter) or reject (Esc) it — reusing the Cmd-K machinery.
  const applyProposedRef = useRef<(code: string) => void>(() => {});
  applyProposedRef.current = (proposed: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model || tab.isReadOnly) return;
    if (inlineStateRef.current) clearInlinePreview();
    const fullRange = model.getFullModelRange();
    const original = model.getValue();
    const state: InlineEditState = {
      range: fullRange,
      original,
      before: "",
      after: "",
      instruction: "(chat apply)",
      proposed,
      busy: false,
      error: null,
      applied: null,
    };
    const applied = applyInlinePreview(state, proposed);
    setInline({ ...state, applied });
    editor.focus?.();
  };

  // Register this editor as the active Apply target while it is mounted.
  useEffect(() => {
    const handler = (code: string) => applyProposedRef.current(code);
    editorApplyBus.setHandler(handler);
    return () => {
      // Only clear if we're still the registered handler (avoid races on
      // fast tab switches where the next editor already registered).
      editorApplyBus.setHandler(null);
    };
  }, [tab.path]);

  // Accept: keep the applied text, just drop the diff overlay.
  const acceptInline = useCallback(() => {
    clearInlinePreview();
    setInline(null);
  }, [clearInlinePreview]);

  // Reject: undo the applied edit and drop the overlay.
  const rejectInline = useCallback(() => {
    const editor = editorRef.current;
    clearInlinePreview();
    if (editor && inlineStateRef.current?.applied) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.trigger("codez-inline-edit", "undo", null);
    }
    setInline(null);
  }, [clearInlinePreview]);

  // Cancel before any proposal was applied.
  const cancelInline = useCallback(() => {
    clearInlinePreview();
    setInline(null);
  }, [clearInlinePreview]);

  // Drop any open inline-edit preview when the file changes (its decorations
  // belong to the previous model).
  useEffect(() => {
    clearInlinePreview();
    setInline(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path]);

  // While the inline diff is applied, Enter accepts and Esc rejects even though
  // keyboard focus is back in the editor.
  useEffect(() => {
    if (!inline?.applied) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        acceptInline();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        rejectInline();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inline?.applied, acceptInline, rejectInline]);

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

      // Restore a previously imported .vsix theme (persisted by ExtensionsPanel)
      // so it applies on startup without opening the Extensions panel.
      try {
        const raw = localStorage.getItem("codez.activeTheme");
        if (raw) {
          const saved = JSON.parse(raw) as { id: string; data: unknown };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          monaco.editor.defineTheme(saved.id, saved.data as any);
          themeStore.set(saved.id);
        }
      } catch {
        // ignore corrupt persisted theme
      }

      // If this editor was opened to navigate to a specific position
      // (e.g. a search result), apply it now that the editor exists.
      if (revealRef.current) {
        requestAnimationFrame(() => applyReveal());
      }

      // ── Persisted .vsix snippets (M6) ──────────────────────────────
      // Re-register snippet completion providers from imported extensions so
      // they work on startup without opening the Extensions panel.
      if (!persistedSnippetsRegistered) {
        persistedSnippetsRegistered = true;
        try {
          registerPersistedSnippets(monaco);
        } catch {
          // non-fatal
        }
      }

      // ── AI Tab completion (ghost text) ─────────────────────────────
      // Register a single global provider (keyed by a flag) so multiple tab
      // mounts don't stack providers. Monaco cancels the previous request's
      // token on each keystroke, which naturally debounces.
      if (!inlineCompletionRegistered) {
        inlineCompletionRegistered = true;
        monaco.languages.registerInlineCompletionsProvider(
          { pattern: "**" },
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            provideInlineCompletions: async (model: any, position: any, _ctx: any, token: any) => {
              if (!tabCompleteEnabled()) return { items: [] };
              const offset = model.getOffsetAt(position);
              const full: string = model.getValue();
              const prefix = full.slice(0, offset);
              const suffix = full.slice(offset);
              // Skip trivial / whitespace-only contexts to cut noise + cost.
              if (prefix.trim().length < 3) return { items: [] };
              // Debounce: wait, then bail if the user kept typing.
              await new Promise((r) => setTimeout(r, 350));
              if (token?.isCancellationRequested) return { items: [] };
              try {
                const text = await aiInlineCompletion({
                  prefix,
                  suffix,
                  language: model.getLanguageId?.() ?? null,
                  modelId: completionModelId(),
                });
                if (token?.isCancellationRequested || !text) return { items: [] };
                return {
                  items: [
                    {
                      insertText: text,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  ],
                };
              } catch {
                return { items: [] };
              }
            },
            freeInlineCompletions: () => {},
          },
        );
      }

      // ── LSP integration ────────────────────────────────────────────
      const lang = tab.language || languageForFile(tab.path);
      const fullPath = projectDir ? `${projectDir}/${tab.path}` : tab.path;

      // ── Debug breakpoints (DAP) — gutter toggling + rendering ───────
      bpDisposeRef.current?.dispose?.();
      if (!tab.isReadOnly) {
        try {
          bpDisposeRef.current = attachBreakpointGutter(editor, monaco, fullPath);
        } catch {
          // non-fatal
        }
      }

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
    [tab.path, tab.language, tab.content, projectDir, applyReveal],
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

    // Cleanup LSP + breakpoint gutter on unmount
    return () => {
      lspRef.current?.dispose();
      lspRef.current = null;
      bpDisposeRef.current?.dispose?.();
      bpDisposeRef.current = null;
    };
  }, [tab.path, tab.content]);

  if (tab.isDiff && tab.originalContent !== undefined) {
    return (
      <DiffEditor
        height="100%"
        theme={editorTheme}
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
        theme={editorTheme}
        language={tab.language || "plaintext"}
        value={tab.content}
        loading={<div className="ide-file-loading"><div className="ide-file-loading-spinner" /></div>}
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
          glyphMargin: true,
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
          inlineSuggest: { enabled: true },
        }}
      />

      {inline && (
        <div className="codez-inline-edit">
          {inline.applied ? (
            <div className="codez-inline-edit-bar">
              <span className="codez-inline-edit-hint">Review the inline diff:</span>
              <button className="codez-inline-accept" onClick={acceptInline}>
                Accept ⏎
              </button>
              <button className="codez-inline-edit-cancel" onClick={rejectInline}>
                Reject ⎋
              </button>
            </div>
          ) : (
            <div className="codez-inline-edit-bar">
              <input
                autoFocus
                className="codez-inline-edit-input"
                placeholder="Edit instruction… (Enter to generate, Esc to cancel)"
                value={inline.instruction}
                onChange={(e) =>
                  setInline((cur) => (cur ? { ...cur, instruction: e.target.value } : cur))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runInline();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelInline();
                  }
                }}
              />
              <button
                onClick={() => void runInline()}
                disabled={inline.busy || !inline.instruction.trim()}
              >
                {inline.busy ? "…" : "Generate"}
              </button>
              <button className="codez-inline-edit-cancel" onClick={cancelInline}>
                Cancel
              </button>
            </div>
          )}
          {inline.error && <div className="codez-inline-edit-error">{inline.error}</div>}
        </div>
      )}
    </div>
  );
}
