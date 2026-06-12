/** Global active Monaco editor theme name, shared across editor instances so
 *  an imported VS Code theme applies everywhere (and survives tab switches). */

import { getAppearanceTheme, type AppearanceTheme } from "../../theme";

export const ACTIVE_EDITOR_THEME_KEY = "agentz.activeTheme";

function defaultEditorThemeName(appearance?: AppearanceTheme): string {
  return (appearance ?? getAppearanceTheme()) === "light" ? "vs" : "vs-dark";
}

function readInitialTheme(): string {
  try {
    const raw = localStorage.getItem(ACTIVE_EDITOR_THEME_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id?: string };
      if (saved.id) return saved.id;
    }
  } catch {
    // ignore corrupt persisted theme
  }
  return defaultEditorThemeName();
}

export function hasImportedEditorTheme(): boolean {
  try {
    const raw = localStorage.getItem(ACTIVE_EDITOR_THEME_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { id?: string };
    return Boolean(saved.id);
  } catch {
    return false;
  }
}

let current = readInitialTheme();
const listeners = new Set<() => void>();

export const themeStore = {
  getSnapshot: () => current,
  subscribe: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  set: (name: string) => {
    if (name === current) return;
    current = name;
    listeners.forEach((l) => l());
  },
};

/** Default built-in Monaco theme for the current app appearance (when no .vsix theme). */
export function resolveDefaultEditorTheme(appearance?: AppearanceTheme): string {
  return defaultEditorThemeName(appearance);
}

/** Follow app light/dark unless the user pinned an imported VS Code theme. */
export function syncEditorThemeWithAppearance(appearance?: AppearanceTheme): void {
  if (hasImportedEditorTheme()) return;
  const name = defaultEditorThemeName(appearance);
  themeStore.set(name);
  void import("@monaco-editor/react")
    .then(({ loader }) => loader.init())
    .then((monaco) => monaco.editor.setTheme(name))
    .catch(() => {
      // Monaco not loaded yet — themeStore update is enough for the next mount.
    });
}
