/** Shared tool name → icon and one-line summary for chat / agent UIs. */

const TOOL_ICONS: Record<string, string> = {
  shell: "💻",
  code_run: "▶️",
  file_read: "📄",
  file_write: "✏️",
  file_edit: "✏️",
  file_list: "📁",
  file_search: "🔍",
  file_diff: "⧉",
  web_search: "🌐",
  browser: "🌍",
  plan_todo: "📋",
  plan_write: "📝",
  plan_mode_ui: "🧭",
  skill_list: "⚡",
};

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "⚙️";
}

export function toolSummary(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i) return "";
  if (name === "shell" || name === "code_run") return String(i.command ?? "").slice(0, 80);
  if (name === "file_read" || name === "file_write" || name === "file_edit" || name === "file_search") {
    return String(i.path ?? i.pattern ?? "").slice(0, 80);
  }
  if (name === "file_list") return String(i.path ?? i.directory ?? ".").slice(0, 80);
  if (name === "web_search") return String(i.query ?? "").slice(0, 80);
  if (name === "plan_todo") return `${Array.isArray(i.todos) ? i.todos.length : 0} items`;
  if (name === "plan_write") return String(i.path ?? ".agentz/plans/…").slice(0, 80);
  if (name === "plan_mode_ui") return String(i.action ?? "").slice(0, 80);
  return Object.entries(i)
    .filter(([k]) => !k.startsWith("_"))
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
    .join(" ");
}

export function summarizeToolCounts(
  tools: { name: string; status: string }[],
): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(" · ");
}
