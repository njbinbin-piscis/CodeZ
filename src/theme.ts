/** App shell appearance (light / dark) — separate from Monaco editor themes. */

export type AppearanceTheme = "dark" | "light";

const STORAGE_KEY = "codez-appearance";

export function getAppearanceTheme(): AppearanceTheme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" ? "light" : "dark";
}

export function applyAppearanceTheme(theme: AppearanceTheme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

export function toggleAppearanceTheme(): AppearanceTheme {
  const next: AppearanceTheme = getAppearanceTheme() === "dark" ? "light" : "dark";
  applyAppearanceTheme(next);
  return next;
}

export function initAppearanceTheme(): AppearanceTheme {
  const theme = getAppearanceTheme();
  applyAppearanceTheme(theme);
  return theme;
}
