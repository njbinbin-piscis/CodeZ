import { invoke } from "@tauri-apps/api/core";

export type FishSource = "builtin" | "user";

export interface FishDef {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  source: FishSource;
}

/** List all available sub-agents (builtin + user-defined from FISH.toml). */
export function listFish(): Promise<FishDef[]> {
  return invoke<FishDef[]>("fish_list");
}

/** Create or update a user sub-agent in FISH.toml. */
export function saveFish(args: {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
}): Promise<void> {
  return invoke<void>("fish_save", args);
}

/** Delete a user sub-agent from FISH.toml (builtin entries cannot be deleted). */
export function deleteFish(id: string): Promise<void> {
  return invoke<void>("fish_delete", { id });
}
