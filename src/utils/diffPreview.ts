export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffPreviewLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffPreview {
  additions: number;
  deletions: number;
  lines: DiffPreviewLine[];
}

const MAX_PREVIEW_LINES = 28;

/** Build a compact unified diff preview for inline FileDiffCard. */
export function buildDiffPreview(
  before: string | null | undefined,
  after: string,
): DiffPreview {
  const afterLines = after.split("\n");
  if (before == null || before === undefined) {
    const preview = afterLines.slice(0, MAX_PREVIEW_LINES).map((text) => ({
      kind: "add" as const,
      text,
    }));
    return {
      additions: afterLines.length,
      deletions: 0,
      lines: preview,
    };
  }

  const beforeLines = before.split("\n");
  const lines: DiffPreviewLine[] = [];
  let additions = 0;
  let deletions = 0;

  // Simple line-hash diff: good enough for small IDE edits in the stream.
  const beforeSet = new Map<string, number>();
  for (const line of beforeLines) {
    beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  }
  const afterCounts = new Map<string, number>();
  for (const line of afterLines) {
    afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  }

  for (const line of beforeLines) {
    const n = beforeSet.get(line) ?? 0;
    const m = afterCounts.get(line) ?? 0;
    if (n > m) {
      deletions += 1;
      if (lines.length < MAX_PREVIEW_LINES) lines.push({ kind: "del", text: line });
      beforeSet.set(line, n - 1);
    }
  }

  for (const line of afterLines) {
    const n = beforeSet.get(line) ?? 0;
    if (n > 0) {
      beforeSet.set(line, n - 1);
      if (lines.length < MAX_PREVIEW_LINES) lines.push({ kind: "ctx", text: line });
      continue;
    }
    additions += 1;
    if (lines.length < MAX_PREVIEW_LINES) lines.push({ kind: "add", text: line });
  }

  if (lines.length === 0 && afterLines.length > 0) {
    return {
      additions: afterLines.length,
      deletions: beforeLines.length,
      lines: afterLines.slice(0, MAX_PREVIEW_LINES).map((text) => ({ kind: "add", text })),
    };
  }

  return { additions, deletions, lines };
}
