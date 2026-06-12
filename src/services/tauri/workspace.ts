import { invoke } from "@tauri-apps/api/core";
import type { OpenTab } from "../../workspaces/codez/types";

export interface EditorSnapshot {
  open_paths: string[];
  active_path: string | null;
  dirty_buffers: Record<string, string>;
}

export interface LayoutSnapshot {
  chat_open: boolean;
  chat_width: number;
  browser_open: boolean;
  mode: "codez" | "workz";
  sidebar_tab: string;
  sidebar_collapsed: boolean;
  sidebar_width: number;
  bottom_open: boolean;
  bottom_tab: string;
  bottom_height: number;
  /** Explorer directory paths that are expanded in the file tree. */
  explorer_expanded_paths?: string[];
}

export interface WorkspaceSnapshot {
  version: number;
  project_dir: string | null;
  editor: EditorSnapshot;
  layout: LayoutSnapshot;
}

/** Build editor snapshot from open tabs (persists dirty buffers). */
export function editorSnapshotFromTabs(
  tabs: OpenTab[],
  activePath: string | null,
): EditorSnapshot {
  const restorable = tabs.filter(
    (t) => !t.path.startsWith("diff:") && t.path !== "__agentz_browser__" && t.viewMode !== "image",
  );
  const dirty_buffers: Record<string, string> = {};
  for (const tab of restorable) {
    if (tab.isDirty) dirty_buffers[tab.path] = tab.content;
  }
  return {
    open_paths: restorable.map((t) => t.path),
    active_path:
      activePath && restorable.some((t) => t.path === activePath)
        ? activePath
        : restorable[0]?.path ?? null,
    dirty_buffers,
  };
}

export function workspaceLoad(): Promise<WorkspaceSnapshot | null> {
  return invoke<WorkspaceSnapshot | null>("workspace_load");
}

export function workspaceSave(snapshot: WorkspaceSnapshot): Promise<void> {
  return invoke<void>("workspace_save", { snapshot });
}

export function workspaceCloseAck(): Promise<void> {
  return invoke<void>("workspace_close_ack");
}
