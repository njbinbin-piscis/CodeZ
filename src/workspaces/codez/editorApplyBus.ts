/**
 * Minimal bridge so the IDE chat "Apply" button (rendered deep inside markdown
 * code blocks) can push a proposed code block into the currently active Monaco
 * editor, which previews it as an inline diff (accept / reject) — without
 * prop-drilling through the whole message tree.
 *
 * The active `CodeEditor` registers itself as the handler on mount and clears
 * it on unmount, so at most one editor (the focused tab) receives applies.
 */
type ApplyHandler = (code: string) => void;

let handler: ApplyHandler | null = null;

export const editorApplyBus = {
  setHandler(fn: ApplyHandler | null) {
    handler = fn;
  },
  apply(code: string): boolean {
    if (!handler) return false;
    handler(code);
    return true;
  },
  hasHandler(): boolean {
    return handler != null;
  },
};
