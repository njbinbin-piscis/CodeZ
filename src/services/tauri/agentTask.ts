/**
 * Tauri IPC — Agent task isolation (M4).
 *
 * Wraps `src-tauri/src/commands/agent_task.rs`. Agent-mode tasks can run inside
 * an isolated git worktree + branch; the resulting diff is reviewed and then
 * merged back, opened as a PR, or discarded — without ever touching the user's
 * main working tree.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AgentTaskInfo {
  id: string;
  branch: string;
  worktree_path: string;
  base: string;
}

export interface AgentTaskChange {
  path: string;
  status: string;
}

export interface AgentTaskFileDiff {
  path: string;
  original: string;
  modified: string;
}

export interface PrResult {
  ok: boolean;
  url: string | null;
  message: string;
}

export const agentTaskApi = {
  create: (projectDir: string, taskId: string, base?: string) =>
    invoke<AgentTaskInfo>("agent_task_create", { projectDir, taskId, base }),

  list: (projectDir: string) =>
    invoke<AgentTaskInfo[]>("agent_task_list", { projectDir }),

  changedFiles: (projectDir: string, branch: string, base: string) =>
    invoke<AgentTaskChange[]>("agent_task_changed_files", {
      projectDir,
      branch,
      base,
    }),

  fileDiff: (projectDir: string, branch: string, base: string, path: string) =>
    invoke<AgentTaskFileDiff>("agent_task_file_diff", {
      projectDir,
      branch,
      base,
      path,
    }),

  merge: (projectDir: string, branch: string, base: string) =>
    invoke<string>("agent_task_merge", { projectDir, branch, base }),

  discard: (projectDir: string, worktreePath: string, branch: string) =>
    invoke<void>("agent_task_discard", { projectDir, worktreePath, branch }),

  openPr: (
    projectDir: string,
    branch: string,
    base: string,
    title: string,
    body?: string,
  ) =>
    invoke<PrResult>("agent_task_open_pr", {
      projectDir,
      branch,
      base,
      title,
      body,
    }),
};
