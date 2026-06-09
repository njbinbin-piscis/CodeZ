// IDE component type definitions

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  children: FileNode[] | null;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  is_binary: boolean;
  size: number;
  language: string | null;
  preview_data?: string | null;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
  context_before: string | null;
  context_after: string | null;
}

export interface GitFileStatus {
  path: string;
  status: string; // modified, added, deleted, untracked, renamed
  staged: boolean;
}

/** One git repository discovered under the workspace root (VS Code-style). */
export interface GitRepoSnapshot {
  repo_root: string;
  name: string;
  files: GitFileStatus[];
  branches: BranchInfo[];
}

export interface DiffResult {
  path: string;
  original: string;
  modified: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  content: string;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  is_koi: boolean;
  last_commit: string | null;
  last_commit_time: string | null;
}

export type TabViewMode = "editor" | "preview" | "image";

export interface OpenTab {
  path: string;
  name: string;
  language: string | null;
  content: string;
  isDirty: boolean;
  isReadOnly: boolean;
  isDiff?: boolean;
  originalContent?: string;
  viewMode?: TabViewMode;
  previewData?: string;
  fileSize?: number;
}
