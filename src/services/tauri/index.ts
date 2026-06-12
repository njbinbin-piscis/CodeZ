/**
 * Minimal Tauri IPC barrel for AgentZ.
 *
 * Only the surface the IDE workspace needs today: revealing a path in the OS
 * file manager and a folder picker for choosing the project directory. The
 * full domain services (chat / pool / config) from openpiscis are intentionally
 * left out — AgentZ wires its own host commands as the milestones land.
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Open a path with the OS default handler. */
export function openPath(path: string): Promise<void> {
  return invoke<void>("open_path", { path });
}

/** Reveal a file or folder in the system file manager. */
export function revealInFolder(path: string): Promise<void> {
  return invoke<void>("reveal_in_folder", { path });
}

/** Prompt the user to choose a project directory. Returns null if cancelled. */
export async function openFolderDialog(defaultPath?: string | null): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: defaultPath ?? undefined,
  });
  if (typeof selected === "string") return selected;
  return null;
}
