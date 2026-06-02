/**
 * AI chat IPC — drives a single agent turn on the piscis-engine kernel and
 * streams kernel events back over a Tauri event channel.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirror of the backend `codez:chat-event` channel name. */
export const CHAT_EVENT = "codez:chat-event";

export interface ChatAttachment {
  media_type: string;
  path?: string | null;
  data?: string | null;
  filename?: string | null;
}

export interface PlanTodoItem {
  id: string;
  content: string;
  status: string;
}

/** Tagged union mirroring `pisci_kernel::agent::messages::AgentEvent`. */
export type AgentEvent =
  | { type: "text_segment_start"; iteration: number }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; is_error: boolean }
  | { type: "plan_update"; items: PlanTodoItem[] }
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
  /** Journal turn id for this turn — drives the Review bar / Undo. */
  turn_id?: string | null;
}

/** One file changed during a turn (from the file journal). */
export interface JournalChange {
  id: number;
  rel_path: string;
  tool_name: string;
  existed: boolean;
  applied: boolean;
}

export type ChatMode = "agent" | "plan";

/** Start one agent turn. Resolves with the final assistant text. */
export function chatSend(args: {
  prompt: string;
  /** User-visible text stored in session history (defaults to prompt). */
  displayPrompt?: string | null;
  sessionId?: string | null;
  projectDir: string;
  /** Isolated worktree the agent should work in (M4). Sessions stay in projectDir. */
  workspaceDir?: string | null;
  attachment?: ChatAttachment | null;
  chatMode?: ChatMode;
  modelId?: string | null;
  clearPlan?: boolean;
  /** Unique key for a parallel Agent task so it can be cancelled on its own (M7). */
  taskKey?: string | null;
}): Promise<ChatResult> {
  return invoke<ChatResult>("chat_send", {
    prompt: args.prompt,
    displayPrompt: args.displayPrompt ?? null,
    sessionId: args.sessionId ?? null,
    workspace: args.projectDir,
    projectDir: args.projectDir,
    workspaceDir: args.workspaceDir ?? null,
    attachment: args.attachment ?? null,
    chatMode: args.chatMode ?? "agent",
    modelId: args.modelId ?? null,
    clearPlan: args.clearPlan ?? true,
    taskKey: args.taskKey ?? null,
  });
}

/** Subscribe to streamed kernel events. Returns an unlisten function. */
export function onChatEvent(cb: (evt: ChatEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<ChatEventEnvelope>(CHAT_EVENT, (e) => cb(e.payload));
}

// ── Session management ───────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  title: string | null;
  status: string;
  message_count: number;
  updated_at: string;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function listSessions(projectDir: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("chat_list_sessions", { projectDir });
}

export function getMessages(sessionId: string, projectDir: string): Promise<MessageDto[]> {
  return invoke<MessageDto[]>("chat_get_messages", { sessionId, projectDir });
}

export function forkSession(
  sessionId: string,
  projectDir: string,
  title?: string,
  upToMessageId?: string | null,
): Promise<SessionMeta> {
  return invoke<SessionMeta>("chat_fork_session", {
    sessionId,
    projectDir,
    title: title ?? null,
    upToMessageId: upToMessageId ?? null,
  });
}

export function restoreCheckpoint(
  sessionId: string,
  messageId: string,
  projectDir: string,
  restoreFiles?: boolean,
): Promise<string[]> {
  return invoke<string[]>("chat_restore_checkpoint", {
    sessionId,
    messageId,
    projectDir,
    restoreFiles: restoreFiles ?? false,
  });
}

export function deleteSession(sessionId: string, projectDir: string): Promise<void> {
  return invoke<void>("chat_delete_session", { sessionId, projectDir });
}

/** Stop an in-flight agent turn. With `taskKey`, stops just that parallel task. */
export function chatCancel(taskKey?: string | null): Promise<void> {
  return invoke<void>("chat_cancel", { taskKey: taskKey ?? null });
}

// ── File journal (Review / Undo) ─────────────────────────────────────────

/** List files changed by a turn (applied, not yet undone). */
export function journalListChanges(
  projectDir: string,
  sessionId: string,
  turnId: string,
): Promise<JournalChange[]> {
  return invoke<JournalChange[]>("journal_list_changes", {
    projectDir,
    sessionId,
    turnId,
  });
}

/** Undo every change in a turn, restoring pre-edit content. Returns paths. */
export function journalUndoTurn(
  projectDir: string,
  sessionId: string,
  turnId: string,
): Promise<string[]> {
  return invoke<string[]>("journal_undo_turn", {
    projectDir,
    sessionId,
    turnId,
  });
}
