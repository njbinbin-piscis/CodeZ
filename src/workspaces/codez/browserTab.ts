/** Synthetic editor tab path for the embedded browser panel. */
export const BROWSER_TAB_PATH = "__agentz_browser__";

export function isBrowserTab(path: string | null | undefined): boolean {
  return path === BROWSER_TAB_PATH;
}
