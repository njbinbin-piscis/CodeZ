/**
 * AI chat IPC — drives a single agent turn on the pisci-engine kernel and
 * streams kernel events back over a Tauri event channel.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirror of the backend `codez:chat-event` channel name. */
export const CHAT_EVENT = "codez:chat-event";

/** Tagged union mirroring `pisci_kernel::agent::messages::AgentEvent`. */
export type AgentEvent =
  | { type: "text_segment_start"; iteration: number }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; is_error: boolean }
  | { type: "done"; total_input_tokens: number; total_output_tokens: number }
  | { type: "cancelled" }
  | { type: "error"; message: string }
  | { type: "other" };

/** Envelope emitted by the backend `TauriEventSink`. */
export interface ChatEventEnvelope {
  sessionId: string | null;
  /** "agent_event" (payload = AgentEvent) or "agent_final" ({ ok, error? }). */
  channel: string;
  payload: AgentEvent | { ok: boolean; error?: string } | Record<string, unknown>;
}

export interface ChatResult {
  ok: boolean;
  session_id: string;
  response_text: string;
}

/** Start one agent turn. Resolves with the final assistant text. */
export function chatSend(args: {
  prompt: string;
  sessionId?: string | null;
  workspace?: string | null;
}): Promise<ChatResult> {
  return invoke<ChatResult>("chat_send", {
    prompt: args.prompt,
    sessionId: args.sessionId ?? null,
    workspace: args.workspace ?? null,
  });
}

/** Subscribe to streamed kernel events. Returns an unlisten function. */
export function onChatEvent(cb: (evt: ChatEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<ChatEventEnvelope>(CHAT_EVENT, (e) => cb(e.payload));
}
