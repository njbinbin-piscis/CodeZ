/** App shell appearance (light / dark) — separate from Monaco editor themes. */

export type AppearanceTheme = "dark" | "light";

export const UI_FONT_SCALES = [0.875, 1, 1.125, 1.25] as const;
export type UiFontScale = (typeof UI_FONT_SCALES)[number];

const STORAGE_KEY = "agentz-appearance";
const FONT_SCALE_KEY = "agentz-ui-font-scale";

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

export function getUiFontScale(): UiFontScale {
  const saved = Number(localStorage.getItem(FONT_SCALE_KEY));
  return (UI_FONT_SCALES as readonly number[]).includes(saved)
    ? (saved as UiFontScale)
    : 1;
}

export function applyUiFontScale(scale: UiFontScale): void {
  document.documentElement.style.setProperty("--ui-font-scale", String(scale));
  localStorage.setItem(FONT_SCALE_KEY, String(scale));
}

export function initUiFontScale(): UiFontScale {
  const scale = getUiFontScale();
  applyUiFontScale(scale);
  return scale;
}

export function uiFontScaleLabel(scale: UiFontScale): string {
  return `${Math.round(scale * 100)}%`;
}
