/**
 * User tools IPC — executable tool plugins installed under
 * `{config}/user-tools/<name>/`. Backs the User Tools section of Settings.
 * Mirrors the `commands::user_tools` Rust module.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ConfigFieldSchema {
  /** "string" | "number" | "boolean" | "password" */
  type: string;
  label?: string;
  default?: unknown;
  description?: string;
  placeholder?: string;
}

export interface UserToolInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  runtime: string;
  entrypoint: string;
  input_schema: unknown;
  config_schema: Record<string, ConfigFieldSchema>;
  has_config: boolean;
}

export function listUserTools(): Promise<UserToolInfo[]> {
  return invoke<UserToolInfo[]>("user_tools_list");
}

/** Install from a local directory path, a raw manifest.json URL, or a .zip URL. */
export function installUserTool(source: string): Promise<UserToolInfo> {
  return invoke<UserToolInfo>("user_tools_install", { source });
}

export function uninstallUserTool(toolName: string): Promise<void> {
  return invoke<void>("user_tools_uninstall", { toolName });
}

export function saveUserToolConfig(
  toolName: string,
  config: Record<string, unknown>,
): Promise<void> {
  return invoke<void>("user_tools_save_config", { toolName, config });
}

export function getUserToolConfig(
  toolName: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("user_tools_get_config", { toolName });
}
