import { useCallback, useEffect, useState } from "react";
import { defaultModelDisplayLabel } from "../components/chatComposerUtils";
import { onSettingsRefresh } from "../services/settingsRefresh";
import {
  getSettings,
  type LlmProviderConfig,
  type SettingsResponse,
} from "../services/tauri/settings";

/** Live LLM / app settings for composer model lists and vision checks. */
export function useAppSettings() {
  const [appSettings, setAppSettings] = useState<SettingsResponse | null>(null);
  const [llmProviders, setLlmProviders] = useState<LlmProviderConfig[]>([]);
  const [defaultModelLabel, setDefaultModelLabel] = useState("");

  const reload = useCallback(() => {
    getSettings()
      .then((s) => {
        setAppSettings(s);
        setLlmProviders(s.llm_providers ?? []);
        setDefaultModelLabel(defaultModelDisplayLabel(s.provider, s.model));
      })
      .catch(() => {
        setAppSettings(null);
        setLlmProviders([]);
        setDefaultModelLabel("");
      });
  }, []);

  useEffect(() => {
    reload();
    return onSettingsRefresh(reload);
  }, [reload]);

  return { appSettings, llmProviders, defaultModelLabel, reloadSettings: reload };
}

/** Drop a model id that no longer exists after settings change. */
export function pruneModelId(
  modelId: string,
  providers: LlmProviderConfig[],
): string {
  if (!modelId) return modelId;
  return providers.some((p) => p.id === modelId) ? modelId : "";
}
