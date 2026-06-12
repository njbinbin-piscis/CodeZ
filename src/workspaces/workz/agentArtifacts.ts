import type { GitFileStatus } from "../codez/types";

export interface AgentToolEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  result?: string;
  path?: string;
  input?: unknown;
}

export interface AgentStep {
  role: "user" | "assistant";
  text: string;
  tools: AgentToolEvent[];
  id?: string;
}

function pathFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file", "file_path", "target"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Extract a relative file path from tool name + payload. */
export function pathFromToolEvent(
  name: string,
  input: unknown,
  result?: string,
): string | undefined {
  const fromInput = pathFromToolInput(input);
  if (fromInput) return normalizeArtifactPath(fromInput);

  if (!result) return undefined;
  const n = name.toLowerCase();
  if (n.includes("file") || n.includes("write") || n.includes("read") || n.includes("edit")) {
    const m = result.match(/(?:^|\s)([^\s'"]+\.[a-zA-Z0-9]+)(?:\s|$)/);
    if (m?.[1]) return normalizeArtifactPath(m[1]);
  }
  return undefined;
}

export function normalizeArtifactPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^[/\\]+/, "");
}

export interface ToolStepLike {
  name: string;
  input: unknown;
  result?: string;
}

/** Agent-produced paths from tool invocations in the current UI step list. */
export function collectArtifactsFromToolSteps(toolSteps: ToolStepLike[]): string[] {
  const paths = new Set<string>();
  for (const step of toolSteps) {
    const p = pathFromToolEvent(step.name, step.input, step.result);
    if (p) paths.add(p);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** Agent-produced paths from persisted WorkZ step history (not git status). */
export function collectArtifactsFromSteps(steps: AgentStep[]): string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    for (const tool of step.tools) {
      const p =
        tool.path != null
          ? normalizeArtifactPath(tool.path)
          : pathFromToolEvent(tool.name, tool.input, tool.result);
      if (p) paths.add(p);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** @deprecated Prefer {@link collectArtifactsFromSteps} — git changes belong in the Changes tab. */
export function collectArtifacts(steps: AgentStep[], _changes?: GitFileStatus[]): string[] {
  return collectArtifactsFromSteps(steps);
}
