/** App shell appearance (light / dark). Built-in Monaco themes follow unless a .vsix theme is pinned. */

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

function applyUiFontScaleNow(scale: UiFontScale): void {
  document.documentElement.style.setProperty("--ui-font-scale", String(scale));
  localStorage.setItem(FONT_SCALE_KEY, String(scale));
}

let fontScaleApplyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFontScale: UiFontScale | null = null;

/** Debounced so rapid select changes do not trigger a layout storm. */
export function applyUiFontScale(scale: UiFontScale): void {
  pendingFontScale = scale;
  if (fontScaleApplyTimer) clearTimeout(fontScaleApplyTimer);
  fontScaleApplyTimer = setTimeout(() => {
    fontScaleApplyTimer = null;
    const next = pendingFontScale ?? scale;
    pendingFontScale = null;
    applyUiFontScaleNow(next);
    window.dispatchEvent(new CustomEvent("agentz-font-scale", { detail: next }));
  }, 250);
}

export function initUiFontScale(): UiFontScale {
  const scale = getUiFontScale();
  applyUiFontScaleNow(scale);
  return scale;
}

export function uiFontScaleLabel(scale: UiFontScale): string {
  return `${Math.round(scale * 100)}%`;
}
