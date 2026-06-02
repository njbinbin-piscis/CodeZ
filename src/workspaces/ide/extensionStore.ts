/**
 * Persistence for imported VS Code `.vsix` extensions (M6).
 *
 * Imported manifests (themes + snippets + languages) are kept in localStorage
 * so the extension list survives reloads and snippet completion providers are
 * re-registered on startup — previously the list lived only in the
 * ExtensionsPanel's React state and was lost on reload.
 */
import type { VsixManifest } from "../../services/tauri/vsix";
import { parseSnippets } from "./vscodeTheme";

const STORAGE_KEY = "codez.extensions";

export function loadExtensions(): VsixManifest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VsixManifest[]) : [];
  } catch {
    return [];
  }
}

export function saveExtensions(extensions: VsixManifest[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(extensions));
  } catch {
    // storage may be full / unavailable — non-fatal
  }
}

/**
 * Register snippet completion providers for every persisted extension.
 * Returns disposables the caller can dispose on unmount. `monaco` is the
 * Monaco namespace (typed loosely to avoid a hard dependency here).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPersistedSnippets(monaco: any): { dispose: () => void }[] {
  const disposables: { dispose: () => void }[] = [];
  for (const ext of loadExtensions()) {
    for (const set of ext.snippets ?? []) {
      if (!set.language) continue;
      let items: ReturnType<typeof parseSnippets> = [];
      try {
        items = parseSnippets(set.content);
      } catch {
        continue;
      }
      if (items.length === 0) continue;
      const d = monaco.languages.registerCompletionItemProvider(set.language, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provideCompletionItems: (model: any, position: any) => {
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
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: s.description,
              detail: `${ext.display_name} snippet`,
              range,
            })),
          };
        },
      });
      disposables.push(d);
    }
  }
  return disposables;
}
