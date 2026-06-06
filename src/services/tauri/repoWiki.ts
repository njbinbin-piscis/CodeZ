/**
 * Repo Wiki IPC (M8) — generate a module/architecture overview of the
 * workspace from the codebase index and persist it to `.agentz/REPO_WIKI.md`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface RepoWikiResult {
  /** Workspace-relative path the wiki was written to. */
  path: string;
  /** The generated markdown. */
  markdown: string;
}

export function generateRepoWiki(projectDir: string): Promise<RepoWikiResult> {
  return invoke<RepoWikiResult>("repo_wiki_generate", { projectDir });
}
