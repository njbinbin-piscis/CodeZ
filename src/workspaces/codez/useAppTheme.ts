import { useEffect, useState } from "react";

export type AppTheme = "dark" | "light";

function readTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Reactively track the app appearance theme (`data-theme` on <html>). */
export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Resolve a CSS custom property from :root to a concrete color string. */
export function cssVar(name: string, fallback = ""): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
