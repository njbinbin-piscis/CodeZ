/**
 * Workbench management IPC — installed skills, project rules, and hooks.
 * Backs the Skills / Rules / Hooks tabs of the unified Settings page.
 */
import { invoke } from "@tauri-apps/api/core";

export interface InstalledSkill {
  slug: string;
  name: string;
  description: string;
  path: string;
  lifecycle?: string;
  locked?: boolean;
  pinned?: boolean;
  quadrant?: string;
}

export interface RuleFile {
  name: string;
  enabled: boolean;
  size: number;
  path: string;
}

export type HookEvent =
  | "beforeAgentTurn"
  | "afterAgentTurn"
  | "beforeFileEdit"
  | "afterFileEdit";

export interface HookDef {
  id: string;
  name: string;
  event: HookEvent;
  command: string;
  enabled: boolean;
}

export interface HooksConfig {
  version: number;
  hooks: HookDef[];
}

export interface HookRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

// --- Skills ---------------------------------------------------------------

export function listInstalledSkills(): Promise<InstalledSkill[]> {
  return invoke<InstalledSkill[]>("skills_list_installed");
}

export function uninstallSkill(slug: string): Promise<void> {
  return invoke<void>("skills_uninstall", { slug });
}

// --- Rules ----------------------------------------------------------------

export function listRules(projectDir: string): Promise<RuleFile[]> {
  return invoke<RuleFile[]>("rules_list", { projectDir });
}

export function readRule(projectDir: string, name: string): Promise<string> {
  return invoke<string>("rules_read", { projectDir, name });
}

export function writeRule(
  projectDir: string,
  name: string,
  content: string,
): Promise<string> {
  return invoke<string>("rules_write", { projectDir, name, content });
}

export function deleteRule(projectDir: string, name: string): Promise<void> {
  return invoke<void>("rules_delete", { projectDir, name });
}

export function setRuleEnabled(
  projectDir: string,
  name: string,
  enabled: boolean,
): Promise<string> {
  return invoke<string>("rules_set_enabled", { projectDir, name, enabled });
}

// --- Hooks ----------------------------------------------------------------

export function getHooks(projectDir: string): Promise<HooksConfig> {
  return invoke<HooksConfig>("hooks_get", { projectDir });
}

export function saveHooks(projectDir: string, config: HooksConfig): Promise<void> {
  return invoke<void>("hooks_save", { projectDir, config });
}

export function runHook(projectDir: string, command: string): Promise<HookRunResult> {
  return invoke<HookRunResult>("hooks_run", { projectDir, command });
}
