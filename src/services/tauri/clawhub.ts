import { invoke } from "@tauri-apps/api/core";

export interface ClawHubSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  stars: number;
  tags: string[];
}

export interface ClawHubSearchResult {
  items: ClawHubSkill[];
  total: number;
  query: string;
}

export interface ClawHubInstallResult {
  slug: string;
  name: string;
  skill_dir: string;
}

export const clawHubApi = {
  search: (query: string, limit?: number) =>
    invoke<ClawHubSearchResult>("clawhub_search", { query, limit }),

  install: (slug: string, version?: string) =>
    invoke<ClawHubInstallResult>("clawhub_install", { slug, version: version ?? null }),
};
