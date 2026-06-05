// Breakpoint model + Monaco glyph-margin integration. Breakpoints are keyed by
// absolute file path and rendered as red dots in the editor gutter; clicking a
// gutter line toggles one. The debug controller reads these to send DAP
// `setBreakpoints` requests.

import type * as monaco from "monaco-editor";

type Listener = () => void;

class BreakpointStore {
  private map = new Map<string, Set<number>>();
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }
  get(path: string): number[] {
    return [...(this.map.get(path) ?? [])].sort((a, b) => a - b);
  }
  all(): Map<string, Set<number>> {
    return this.map;
  }
  toggle(path: string, line: number): void {
    const set = this.map.get(path) ?? new Set<number>();
    if (set.has(line)) set.delete(line);
    else set.add(line);
    if (set.size === 0) this.map.delete(path);
    else this.map.set(path, set);
    this.emit();
  }
  has(path: string, line: number): boolean {
    return this.map.get(path)?.has(line) ?? false;
  }
}

export const breakpointStore = new BreakpointStore();

/**
 * Attach breakpoint toggling + rendering to a Monaco editor for `path`.
 * Returns a disposer. Requires `glyphMargin: true` in editor options.
 */
export function attachBreakpointGutter(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoNs: typeof monaco,
  path: string,
): monaco.IDisposable {
  let collection = editor.createDecorationsCollection([]);

  const render = () => {
    const lines = breakpointStore.get(path);
    collection.set(
      lines.map((line) => ({
        range: new monacoNs.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: "codez-bp-glyph",
          glyphMarginHoverMessage: { value: "Breakpoint" },
        },
      })),
    );
  };

  const mouseSub = editor.onMouseDown((e) => {
    if (e.target.type === monacoNs.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      const line = e.target.position?.lineNumber;
      if (line) breakpointStore.toggle(path, line);
    }
  });
  const storeSub = breakpointStore.subscribe(render);
  render();

  return {
    dispose: () => {
      mouseSub.dispose();
      storeSub();
      collection.clear();
    },
  };
}
