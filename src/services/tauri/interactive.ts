import { invoke } from "@tauri-apps/api/core";

/** Send the user's structured input back to a blocking `chat_ui` tool. */
export function respondInteractiveUi(
  requestId: string,
  values: Record<string, unknown>,
): Promise<void> {
  return invoke<void>("respond_interactive_ui", { requestId, values });
}
