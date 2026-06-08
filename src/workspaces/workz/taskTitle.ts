const COORDINATOR_PREFIX = "You are the coordinator of team pool";
const TASK_MARKER = "\n\nTask:\n";

/** User-visible task goal — strips swarm coordinator preamble when present. */
export function workzGoalFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const idx = trimmed.lastIndexOf(TASK_MARKER);
  if (idx >= 0) {
    const goal = trimmed.slice(idx + TASK_MARKER.length).trim();
    if (goal) return goal.split("\n")[0]?.trim() ?? goal;
  }
  if (trimmed.startsWith(COORDINATOR_PREFIX)) return "";
  return trimmed.split("\n")[0]?.trim() ?? trimmed;
}

export function taskDisplayTitle(
  title: string | null | undefined,
  fallback: string,
): string {
  const raw = title?.trim() ?? "";
  if (!raw) return fallback;
  const goal = workzGoalFromText(raw);
  if (goal) return goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
  if (raw.startsWith(COORDINATOR_PREFIX)) return fallback;
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}
