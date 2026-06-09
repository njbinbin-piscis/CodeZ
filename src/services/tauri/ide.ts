/**
 * Tauri IPC — IDE domain.
 *
 * Wraps Rust-side `src-tauri/src/commands/ide.rs` commands for the
 * embedded Monaco Editor IDE inside the Pond collaboration workspace.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

import type {
  FileNode,
  FileContent,
  SearchResult,
  GitFileStatus,
  GitRepoSnapshot,
  DiffResult,
  BranchInfo,
} from "../../workspaces/codez/types";

// ─── File operations ─────────────────────────────────────────────────────

export const ideApi = {
  listFiles: (projectDir: string, depth?: number) =>
    invoke<FileNode[]>("ide_list_files", { projectDir, depth }),

  readFile: (path: string) => invoke<FileContent>("ide_read_file", { path }),

  writeFile: (path: string, content: string) =>
    invoke<void>("ide_write_file", { path, content }),

  fileAction: (path: string, action: string, newPath?: string) =>
    invoke<void>("ide_file_action", { path, action, newPath }),

  searchFiles: (
    projectDir: string,
    query: string,
    opts?: {
      filePattern?: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
      excludePattern?: string;
    },
  ) =>
    invoke<SearchResult[]>("ide_search_files", {
      projectDir,
      query,
      filePattern: opts?.filePattern,
      caseSensitive: opts?.caseSensitive,
      wholeWord: opts?.wholeWord,
      useRegex: opts?.useRegex,
      excludePattern: opts?.excludePattern,
    }),

  // ─── Git operations ──────────────────────────────────────────────────

  gitStatus: (projectDir: string) =>
    invoke<GitFileStatus[]>("ide_git_status", { projectDir }),

  gitWorkspaceStatus: (projectDir: string) =>
    invoke<GitRepoSnapshot[]>("ide_git_workspace_status", { projectDir }),

  gitDiff: (projectDir: string, path: string, base?: string, gitRoot?: string | null) =>
    invoke<DiffResult>("ide_git_diff", {
      projectDir,
      path,
      base,
      gitRoot: gitRoot ?? null,
    }),

  gitBranches: (projectDir: string, gitRoot?: string | null) =>
    invoke<BranchInfo[]>("ide_git_branches", { projectDir, gitRoot: gitRoot ?? null }),

  gitFileAtRef: (projectDir: string, path: string, gitRef: string, gitRoot?: string | null) =>
    invoke<FileContent>("ide_git_file_at_ref", {
      projectDir,
      path,
      gitRef,
      gitRoot: gitRoot ?? null,
    }),

  gitAdd: (projectDir: string, path: string, gitRoot?: string | null) =>
    invoke<void>("ide_git_add", { projectDir, path, gitRoot: gitRoot ?? null }),

  gitReset: (projectDir: string, path: string, gitRoot?: string | null) =>
    invoke<void>("ide_git_reset", { projectDir, path, gitRoot: gitRoot ?? null }),

  gitDiscard: (projectDir: string, path: string, gitRoot?: string | null) =>
    invoke<void>("ide_git_discard", { projectDir, path, gitRoot: gitRoot ?? null }),

  gitAddAll: (projectDir: string, gitRoot?: string | null) =>
    invoke<void>("ide_git_add_all", { projectDir, gitRoot: gitRoot ?? null }),

  gitResetAll: (projectDir: string, gitRoot?: string | null) =>
    invoke<void>("ide_git_reset_all", { projectDir, gitRoot: gitRoot ?? null }),

  gitCommit: (projectDir: string, message: string, gitRoot?: string | null) =>
    invoke<string>("ide_git_commit", { projectDir, message, gitRoot: gitRoot ?? null }),

  gitCheckout: (projectDir: string, branch: string, gitRoot?: string | null) =>
    invoke<string>("ide_git_checkout", { projectDir, branch, gitRoot: gitRoot ?? null }),

  gitCreateBranch: (projectDir: string, branch: string, gitRoot?: string | null) =>
    invoke<string>("ide_git_create_branch", { projectDir, branch, gitRoot: gitRoot ?? null }),

  // ─── Terminal ────────────────────────────────────────────────────────

  terminalCreate: (
    terminalId: string,
    projectDir: string,
    cols?: number,
    rows?: number,
  ) =>
    invoke<void>("ide_terminal_create", {
      terminalId,
      projectDir,
      cols,
      rows,
    }),

  terminalWrite: (terminalId: string, data: string) =>
    invoke<void>("ide_terminal_write", { terminalId, data }),

  terminalResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("ide_terminal_resize", { terminalId, cols, rows }),

  terminalDestroy: (terminalId: string) =>
    invoke<void>("ide_terminal_destroy", { terminalId }),

  terminalCount: () => invoke<number>("ide_terminal_count"),

  terminalDestroyAll: () => invoke<void>("ide_terminal_destroy_all"),

  terminalIsAlive: (terminalId: string) =>
    invoke<boolean>("ide_terminal_is_alive", { terminalId }),

  // ─── File watcher ──────────────────────────────────────────────────

  startWatcher: (projectDir: string) =>
    invoke<void>("ide_start_watcher", { projectDir }),

  stopWatcher: (projectDir: string) =>
    invoke<void>("ide_stop_watcher", { projectDir }),
};

// ─── Event listeners ─────────────────────────────────────────────────────

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface FileChangedEvent {
  project_dir: string;
  path: string;
  kind: "created" | "modified" | "deleted";
}

export function onTerminalOutput(
  cb: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("ide-terminal-output", (e) => cb(e.payload));
}

export function onFileChanged(
  cb: (event: FileChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangedEvent>("ide-file-changed", (e) => cb(e.payload));
}
