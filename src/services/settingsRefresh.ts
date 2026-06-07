/** Fired after settings are saved so open panels reload LLM / app config. */
export const SETTINGS_REFRESH_EVENT = "agentz-settings-refresh";

export function notifySettingsRefresh(): void {
  window.dispatchEvent(new CustomEvent(SETTINGS_REFRESH_EVENT));
}

export function onSettingsRefresh(handler: () => void): () => void {
  window.addEventListener(SETTINGS_REFRESH_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_REFRESH_EVENT, handler);
}
