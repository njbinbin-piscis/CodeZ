/** `.vsix` ingestion IPC + file picker. */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface VsixTheme {
  label: string;
  ui_theme: string;
  content: string;
}

export interface VsixSnippetSet {
  language: string;
  content: string;
}

export interface VsixManifest {
  name: string;
  display_name: string;
  publisher: string;
  version: string;
  themes: VsixTheme[];
  snippets: VsixSnippetSet[];
  languages: string[];
}

export function importVsix(path: string): Promise<VsixManifest> {
  return invoke<VsixManifest>("import_vsix", { path });
}

/** Prompt for a `.vsix` file. Returns null if cancelled. */
export async function openVsixDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "VS Code extension", extensions: ["vsix"] }],
  });
  if (typeof selected === "string") return selected;
  return null;
}
