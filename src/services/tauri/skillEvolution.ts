import { invoke } from "@tauri-apps/api/core";

export interface SkillRevision {
  id: string;
  skill_id: string;
  session_id: string | null;
  origin: string;
  diff_summary: string | null;
  content_before_hash: string | null;
  content_after_hash: string | null;
  created_at: string;
}

export interface SkillUsage {
  skill_id: string;
  use_count: number;
  last_used_at: string | null;
  last_patched_at: string | null;
  created_by: string | null;
  state: string;
  pinned: boolean;
}

export interface CuratorStatus {
  last_run_at: string | null;
  agent_created_count: number;
  draft_count: number;
  learned_count: number;
  archived_count: number;
  top_used: SkillUsage[];
  least_used: SkillUsage[];
}

export interface SkillEvolutionSettings {
  review_enabled: boolean;
  review_every_turn: boolean;
  create_skill_min_tool_calls: number;
  umbrella_skill_interval_turns: number;
  curator_interval_hours: number;
  curator_min_idle_hours: number;
  stale_after_days: number;
  archive_after_days: number;
  curator_llm_merge_enabled: boolean;
}

export const skillEvolutionApi = {
  promote: (skillId: string) => invoke<void>("promote_skill", { skillId }),
  discard: (skillId: string) => invoke<void>("discard_draft_skill", { skillId }),
  lock: (skillId: string) => invoke<void>("lock_skill", { skillId }),
  unlock: (skillId: string) => invoke<void>("unlock_skill", { skillId }),
  pin: (skillId: string) => invoke<void>("pin_skill", { skillId }),
  unpin: (skillId: string) => invoke<void>("unpin_skill", { skillId }),
  listRevisions: (params?: { skillId?: string; sessionId?: string; limit?: number }) =>
    invoke<{ revisions: SkillRevision[] }>("list_skill_revisions", {
      skillId: params?.skillId,
      sessionId: params?.sessionId,
      limit: params?.limit,
    }),
  listUsage: () => invoke<{ usage: SkillUsage[] }>("list_skill_usage"),
  curatorStatus: () => invoke<CuratorStatus>("curator_status"),
  curatorRun: (dryRun?: boolean) => invoke<string>("curator_run", { dryRun }),
  curatorRollback: () => invoke<void>("curator_rollback"),
  restoreArchived: (skillId: string) =>
    invoke<void>("restore_archived_skill", { skillId }),
  migrateLegacy: () =>
    invoke<{ moved: number; message: string }>("skills_migrate_legacy_layout"),
  getSettings: () => invoke<SkillEvolutionSettings>("get_skill_evolution_settings"),
  saveSettings: (updates: SkillEvolutionSettings) =>
    invoke<SkillEvolutionSettings>("save_skill_evolution_settings", { updates }),
};
