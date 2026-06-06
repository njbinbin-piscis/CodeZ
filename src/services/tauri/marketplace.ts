/**
 * Marketplace IPC (Phase 4) — unified multi-source discovery + install across
 * Tools / Skills / Agents / Teams / Connectors. Mirrors `commands::marketplace`.
 */
import { invoke } from "@tauri-apps/api/core";

export type MarketCategory = "tool" | "skill" | "agent" | "team" | "connector";

export interface MarketItem {
  id: string;
  name: string;
  description: string;
  version: string;
  category: MarketCategory;
  /** "clawhub" | "local" | "builtin" | "remote" */
  source: string;
  icon: string;
  tag: string;
  stars: number;
  installed: boolean;
  authorized: boolean;
}

export function marketplaceSearch(category: MarketCategory, query: string): Promise<MarketItem[]> {
  return invoke<MarketItem[]>("marketplace_search", { category, query });
}

export function marketplaceInstall(
  category: MarketCategory,
  source: string,
  identifier: string,
  version?: string | null,
): Promise<void> {
  return invoke<void>("marketplace_install", {
    category,
    source,
    identifier,
    version: version ?? null,
  });
}

export function marketplaceUninstall(category: MarketCategory, id: string): Promise<void> {
  return invoke<void>("marketplace_uninstall", { category, id });
}
