/**
 * Connectors IPC (Phase 0B) — authenticated external services (通达信 / 腾讯文档 /
 * QQ邮箱 / 飞书·钉钉·企微 OA-数据 …) exposed to the agent as MCP tools.
 * Mirrors `commands::connectors`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ConnectorAuthField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  icon: string;
  color: string;
  category: string;
  description: string;
  kind: string;
  transport: string;
  /** "none" | "api_key" | "token" | "oauth2" */
  auth_method: string;
  fields: ConnectorAuthField[];
  enabled: boolean;
  authorized: boolean;
  /** Present for `kind: api` connectors. */
  url?: string | null;
  use_case?: string | null;
  parameters?: string | null;
}

export interface CreateApiConnectorRequest {
  id: string;
  name: string;
  url: string;
  api_key: string;
  use_case?: string;
  parameters?: string;
  method?: string;
  category?: string;
  icon?: string;
  description?: string;
}

export function listConnectors(): Promise<ConnectorInfo[]> {
  return invoke<ConnectorInfo[]>("connectors_list");
}

/** Install from a local connector.json path/dir or an HTTPS raw connector.json URL. */
export function installConnector(source: string): Promise<ConnectorInfo> {
  return invoke<ConnectorInfo>("connectors_install", { source });
}

export function uninstallConnector(id: string): Promise<void> {
  return invoke<void>("connectors_uninstall", { id });
}

export function setConnectorEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("connectors_set_enabled", { id, enabled });
}

export function saveConnectorCredentials(
  id: string,
  credentials: Record<string, string>,
): Promise<void> {
  return invoke<void>("connectors_save_credentials", { id, credentials });
}

export function getConnectorCredentials(id: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("connectors_get_credentials", { id });
}

/** Create an inline HTTP API connector (video / ASR / TTS / OCR / custom). */
export function createApiConnector(req: CreateApiConnectorRequest): Promise<ConnectorInfo> {
  return invoke<ConnectorInfo>("connectors_create_api", { req });
}
