/**
 * Teams IPC (Phase 3) — installable Pool templates. A team bundles an
 * `org_spec` (organization contract) with its member agents and a workflow.
 */
import { invoke } from "@tauri-apps/api/core";

export interface TeamInfo {
  id: string;
  name: string;
  description: string;
  workflow: string;
  members: string[];
}

export interface TeamManifest {
  id: string;
  name: string;
  description?: string;
  org_spec?: string;
  members?: string[];
  workflow?: string;
  task_timeout_secs?: number;
}

export interface PoolCreated {
  pool_id: string;
  name: string;
  member_koi_ids: string[];
}

export function listTeams(): Promise<TeamInfo[]> {
  return invoke<TeamInfo[]>("teams_list");
}

export function getTeam(id: string): Promise<TeamManifest> {
  return invoke<TeamManifest>("teams_get", { id });
}

export function saveTeam(manifest: TeamManifest): Promise<TeamInfo> {
  return invoke<TeamInfo>("teams_save", { manifest });
}

export function installTeam(source: string): Promise<TeamInfo> {
  return invoke<TeamInfo>("teams_install", { source });
}

export function uninstallTeam(id: string): Promise<void> {
  return invoke<void>("teams_uninstall", { id });
}

/** Create (or reuse) a Pool in the project DB from a team template. */
export function createPoolFromTeam(projectDir: string, teamId: string): Promise<PoolCreated> {
  return invoke<PoolCreated>("teams_create_pool", { projectDir, teamId });
}
