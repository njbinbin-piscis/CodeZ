import type { AgentEvent } from "../../services/tauri/chat";
import { pathFromToolEvent, type AgentToolEvent } from "./agentArtifacts";

export function applyToolStart(tools: AgentToolEvent[], evt: Extract<AgentEvent, { type: "tool_start" }>): AgentToolEvent[] {
  return [
    ...tools,
    {
      id: evt.id,
      name: evt.name,
      status: "running",
      input: evt.input,
      path: pathFromToolEvent(evt.name, evt.input),
    },
  ];
}

export function applyToolEnd(tools: AgentToolEvent[], evt: Extract<AgentEvent, { type: "tool_end" }>): AgentToolEvent[] {
  const status = evt.is_error ? "error" : "done";
  const path = pathFromToolEvent(evt.name, undefined, evt.result);

  const patch = (t: AgentToolEvent): AgentToolEvent => ({
    ...t,
    id: evt.id,
    name: evt.name,
    status,
    result: evt.result,
    path: path ?? t.path,
  });

  const byId = tools.findIndex((t) => t.id === evt.id);
  if (byId >= 0) {
    return tools.map((t, i) => (i === byId ? patch(t) : t));
  }

  // Race: tool_end may arrive before tool_start state lands — match last in-flight call.
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].name === evt.name && tools[i].status === "running") {
      return tools.map((t, idx) => (idx === i ? patch(t) : t));
    }
  }

  return [
    ...tools,
    {
      id: evt.id,
      name: evt.name,
      status,
      result: evt.result,
      path,
    },
  ];
}

/** Clear stale in-flight markers when the turn finishes. */
export function finalizeTools(tools: AgentToolEvent[]): AgentToolEvent[] {
  return tools.map((t) => (t.status === "running" ? { ...t, status: "done" as const } : t));
}
