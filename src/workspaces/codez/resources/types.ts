import type { MarketCategory } from "../../../services/tauri/marketplace";

export type LibraryCategory = MarketCategory | "fish";

export type LibraryView = "installed" | "discover" | "compose";

export interface LibraryInitialState {
  category?: LibraryCategory;
  view?: LibraryView;
  editId?: string;
  expandConnectorId?: string;
}

export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  "skill",
  "tool",
  "agent",
  "team",
  "connector",
  "fish",
];

export function viewsForCategory(cat: LibraryCategory): LibraryView[] {
  if (cat === "fish") return ["installed"];
  if (cat === "skill" || cat === "tool" || cat === "connector") {
    return ["installed", "discover"];
  }
  return ["installed", "discover", "compose"];
}
