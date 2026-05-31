import { useCallback, useEffect, useRef, useState } from "react";
import { useMonaco } from "@monaco-editor/react";
import {
  importVsix,
  openVsixDialog,
  type VsixManifest,
  type VsixTheme,
} from "../../services/tauri/vsix";
import { vscodeThemeToMonaco, parseSnippets } from "./vscodeTheme";
import { themeStore } from "./themeStore";
import "./ExtensionsPanel.css";

interface ExtensionsPanelProps {
  onClose: () => void;
}

const STORAGE_KEY = "codez.activeTheme";

/** Sanitize a label into a Monaco-safe theme id. */
function themeId(ext: VsixManifest, t: VsixTheme): string {
  return `vsix-${ext.name}-${t.label}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export default function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const monaco = useMonaco();
  const [extensions, setExtensions] = useState<VsixManifest[]>([]);
  const [activeTheme, setActiveTheme] = useState<string>(themeStore.getSnapshot());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const snippetDisposables = useRef<{ dispose: () => void }[]>([]);

  // Restore a previously applied theme on first mount (survives reloads).
  useEffect(() => {
    if (!monaco) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { id: string; data: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      monaco.editor.defineTheme(saved.id, saved.data as any);
      monaco.editor.setTheme(saved.id);
      themeStore.set(saved.id);
      setActiveTheme(saved.id);
    } catch {
      // ignore corrupt persisted theme
    }
  }, [monaco]);

  const registerSnippets = useCallback(
    (ext: VsixManifest) => {
      if (!monaco) return;
      for (const set of ext.snippets) {
        if (!set.language) continue;
        let items: ReturnType<typeof parseSnippets> = [];
        try {
          items = parseSnippets(set.content);
        } catch {
          continue;
        }
        if (items.length === 0) continue;
        const d = monaco.languages.registerCompletionItemProvider(set.language, {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items.map((s) => ({
                label: s.prefix,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: s.body,
                insertTextRules:
                  monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: s.description,
                detail: `${ext.display_name} snippet`,
                range,
              })),
            };
          },
        });
        snippetDisposables.current.push(d);
      }
    },
    [monaco],
  );

  const doImport = useCallback(async () => {
    setError(null);
    try {
      const path = await openVsixDialog();
      if (!path) return;
      setBusy(true);
      const manifest = await importVsix(path);
      setExtensions((prev) => [...prev.filter((e) => e.name !== manifest.name), manifest]);
      registerSnippets(manifest);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [registerSnippets]);

  const applyTheme = useCallback(
    (ext: VsixManifest, t: VsixTheme) => {
      if (!monaco) return;
      try {
        const data = vscodeThemeToMonaco(t.content, t.ui_theme);
        const id = themeId(ext, t);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        monaco.editor.defineTheme(id, data as any);
        monaco.editor.setTheme(id);
        themeStore.set(id);
        setActiveTheme(id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, data }));
      } catch (e) {
        setError(`Failed to apply theme: ${e}`);
      }
    },
    [monaco],
  );

  const resetTheme = useCallback(() => {
    if (!monaco) return;
    monaco.editor.setTheme("vs-dark");
    themeStore.set("vs-dark");
    setActiveTheme("vs-dark");
    localStorage.removeItem(STORAGE_KEY);
  }, [monaco]);

  return (
    <div className="codez-ext-overlay" onClick={onClose}>
      <div className="codez-ext-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codez-ext-header">
          <span>Extensions (VS Code .vsix)</span>
          <button onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="codez-ext-toolbar">
          <button className="codez-ext-import" onClick={() => void doImport()} disabled={busy}>
            {busy ? "Importing…" : "Import .vsix…"}
          </button>
          <button className="codez-ext-reset" onClick={resetTheme} disabled={activeTheme === "vs-dark"}>
            Reset theme
          </button>
        </div>

        {error && <div className="codez-ext-error">{error}</div>}

        <div className="codez-ext-body">
          {extensions.length === 0 && (
            <div className="codez-ext-empty">
              Import a <code>.vsix</code> to consume its declarative contributions —
              color themes and snippets. (Bring your own file; extension JS is never
              executed.)
            </div>
          )}
          {extensions.map((ext) => (
            <div key={ext.name} className="codez-ext-card">
              <div className="codez-ext-name">
                {ext.display_name}
                <span className="codez-ext-ver">
                  {ext.publisher ? `${ext.publisher} · ` : ""}v{ext.version || "?"}
                </span>
              </div>
              {ext.themes.length > 0 && (
                <div className="codez-ext-section">
                  <div className="codez-ext-section-title">Themes</div>
                  {ext.themes.map((t) => {
                    const id = themeId(ext, t);
                    return (
                      <button
                        key={id}
                        className={`codez-ext-theme ${id === activeTheme ? "active" : ""}`}
                        onClick={() => applyTheme(ext, t)}
                      >
                        {t.label}
                        {id === activeTheme && <span className="codez-ext-applied">✓ applied</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {ext.snippets.length > 0 && (
                <div className="codez-ext-section">
                  <div className="codez-ext-section-title">
                    Snippets registered for: {ext.snippets.map((s) => s.language).join(", ")}
                  </div>
                </div>
              )}
              {ext.languages.length > 0 && (
                <div className="codez-ext-langs">Languages: {ext.languages.join(", ")}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
