/** LLM settings IPC — reads/writes `config.json` via the Tauri backend. */
import { invoke } from "@tauri-apps/api/core";

export interface LlmProviderConfig {
  id: string;
  label: string;
  provider: string;
  model: string;
  api_key: string;
  base_url: string;
  max_tokens: number;
}

export interface LlmSettings {
  provider: string;
  model: string;
  custom_base_url: string;
  max_tokens: number;
  context_window: number;
  policy_mode: string;
  enable_streaming: boolean;
  language: string;
  vision_enabled: boolean;
  anthropic_api_key: string;
  openai_api_key: string;
  deepseek_api_key: string;
  qwen_api_key: string;
  minimax_api_key: string;
  zhipu_api_key: string;
  kimi_api_key: string;
  llm_providers: LlmProviderConfig[];
}

export interface SettingsResponse extends LlmSettings {
  config_dir: string;
  is_configured: boolean;
}

export function getSettings(): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("get_settings");
}

export function isConfigured(): Promise<boolean> {
  return invoke<boolean>("is_configured");
}

export function saveSettings(updates: LlmSettings): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("save_settings", { updates });
}
