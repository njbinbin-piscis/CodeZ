/**
 * Pool (team collaboration) IPC (Phase 3) — board reads + lifecycle. The kernel
 * owns orchestration; these expose the project DB rows the collaboration board
 * renders, plus a single typed `codez:pool-event` stream for live updates.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const POOL_EVENT = "codez:pool-event";

export interface PoolSession {
  id: string;
  name: string;
  org_spec: string;
  status: string;
  project_dir: string | null;
  task_timeout_secs: number;
  member_koi_ids: string[];
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PoolMember {
  koi_id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  status: string;
}

export interface PoolMessage {
  id: number;
  pool_session_id: string;
  sender_id: string;
  content: string;
  msg_type: string;
  metadata: string;
  todo_id: string | null;
  reply_to_message_id: number | null;
  event_type: string | null;
  created_at: string;
}

export interface KoiTodo {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_by: string;
  pool_session_id: string | null;
  claimed_by: string | null;
  [key: string]: unknown;
}

export function poolList(projectDir: string): Promise<PoolSession[]> {
  return invoke<PoolSession[]>("pool_list", { projectDir });
}

export function poolGet(projectDir: string, poolId: string): Promise<PoolSession | null> {
  return invoke<PoolSession | null>("pool_get", { projectDir, poolId });
}

export function poolMembers(projectDir: string, poolId: string): Promise<PoolMember[]> {
  return invoke<PoolMember[]>("pool_members", { projectDir, poolId });
}

export function poolMessages(
  projectDir: string,
  poolId: string,
  limit = 200,
  offset = 0,
): Promise<PoolMessage[]> {
  return invoke<PoolMessage[]>("pool_messages", { projectDir, poolId, limit, offset });
}

export function poolTodos(projectDir: string, poolId: string): Promise<KoiTodo[]> {
  return invoke<KoiTodo[]>("pool_todos", { projectDir, poolId });
}

export function poolSetStatus(projectDir: string, poolId: string, status: string): Promise<void> {
  return invoke<void>("pool_set_status", { projectDir, poolId, status });
}

export function poolDelete(projectDir: string, poolId: string): Promise<void> {
  return invoke<void>("pool_delete", { projectDir, poolId });
}

/** Subscribe to the typed pool event stream. Payload carries a `kind` tag. */
export function onPoolEvent(cb: (event: { kind: string } & Record<string, unknown>) => void): Promise<UnlistenFn> {
  return listen<{ kind: string } & Record<string, unknown>>(POOL_EVENT, (e) => cb(e.payload));
}
