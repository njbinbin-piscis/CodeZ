/**
 * Tauri IPC — codebase index + search (M5).
 *
 * Wraps `src-tauri/src/commands/codebase.rs`. Powers the `@codebase` mention
 * and the `codebase_search` agent tool with whole-repo keyword/TF recall.
 */
import { invoke } from "@tauri-apps/api/core";

export interface CodeSearchHit {
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  score: number;
}

export const codebaseApi = {
  build: (projectDir: string) =>
    invoke<number>("codebase_index_build", { projectDir }),

  search: (projectDir: string, query: string, limit?: number) =>
    invoke<CodeSearchHit[]>("codebase_search", { projectDir, query, limit }),
};
