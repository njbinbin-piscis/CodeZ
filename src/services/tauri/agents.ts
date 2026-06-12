/**
 * Agents IPC — installable assistant personas bundled as prompt + skills + tools.
 * system prompt with the skills / tools / MCP servers and model it runs with.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  description: string;
  skills: string[];
  tools: string[];
  mcp_servers: string[];
  connectors: string[];
  llm_provider_id: string | null;
  koi_id: string | null;
}

export interface AgentManifest {
  id: string;
  name: string;
  role?: string;
  icon?: string;
  color?: string;
  description?: string;
  system_prompt?: string;
  skills?: string[];
  tools?: string[];
  mcp_servers?: string[];
  connectors?: string[];
  llm_provider_id?: string | null;
  max_iterations?: number;
  task_timeout_secs?: number;
  koi_id?: string | null;
}

export interface BuiltinToolInfo {
  id: string;
  label: string;
  hint: string;
  group: string;
}

export function listAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>("agents_list");
}

export function listBuiltinTools(): Promise<BuiltinToolInfo[]> {
  return invoke<BuiltinToolInfo[]>("agents_list_builtin_tools");
}

export function getAgent(id: string): Promise<AgentManifest> {
  return invoke<AgentManifest>("agents_get", { id });
}

export function saveAgent(manifest: AgentManifest): Promise<AgentInfo> {
  return invoke<AgentInfo>("agents_save", { manifest });
}

export function installAgent(source: string): Promise<AgentInfo> {
  return invoke<AgentInfo>("agents_install", { source });
}

export function uninstallAgent(id: string): Promise<void> {
  return invoke<void>("agents_uninstall", { id });
}

/** Mirror installed agents into a project's member-assistant table. Returns synced count. */
export function syncAgents(projectDir: string): Promise<number> {
  return invoke<number>("agents_sync", { projectDir });
}
