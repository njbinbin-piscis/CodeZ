/**
 * Native yes/no prompt. `window.confirm` is unreliable inside Tauri's
 * webview (often invisible or always false), which blocked closing or
 * switching the project folder whenever a PTY session existed.
 */
import { ask } from "@tauri-apps/plugin-dialog";

export async function confirmDialog(
  message: string,
  options?: { title?: string },
): Promise<boolean> {
  try {
    return await ask(message, {
      title: options?.title ?? "CodeZ",
      kind: "warning",
    });
  } catch {
    // Fallback for `vite preview` in a plain browser.
    return window.confirm(message);
  }
}
