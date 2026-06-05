/** Max characters inlined per @file reference sent to the LLM. */
export const MAX_FILE_REF_CHARS = 12_000;

/** Max total characters from all @file references in one turn. */
export const MAX_TOTAL_REF_CHARS = 48_000;

const LEGACY_CONTEXT_PREFIX = "Context from referenced files:";
const LEGACY_CONTEXT_SEP = "\n---\n\n";

/** Strip legacy expanded @file context from stored user messages. */
export function formatUserMessageDisplay(content: string): string {
  if (!content.includes(LEGACY_CONTEXT_PREFIX)) return content;
  const idx = content.lastIndexOf(LEGACY_CONTEXT_SEP);
  if (idx >= 0) return content.slice(idx + LEGACY_CONTEXT_SEP.length).trimEnd();
  return content;
}

export type UserMessagePart =
  | { type: "text"; value: string }
  | { type: "ref"; path: string; isDir: boolean }
  | { type: "browser-element"; selector: string; label: string }
  | { type: "terminal-snippet"; snippetId: string; label: string };

/** Split user message into plain text, @file refs, and special chips. */
export function parseUserMessageRefs(text: string): UserMessagePart[] {
  const normalized = formatUserMessageDisplay(text);
  const parts: UserMessagePart[] = [];
  const re =
    /(^|\s)(@browser-element\(([^)]+)\)|@terminal-snippet\(([^)]+)\)|@([^\s]+))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const before = normalized.slice(last, match.index + (match[1]?.length ?? 0));
    if (before) parts.push({ type: "text", value: before });
    if (match[2]) {
      const selector = match[3];
      const tagMatch = selector.match(/^([a-z][a-z0-9-]*)/i);
      parts.push({
        type: "browser-element",
        selector,
        label: tagMatch ? `<${tagMatch[1]}>` : selector,
      });
    } else if (match[4]) {
      const snippetId = match[4];
      parts.push({
        type: "terminal-snippet",
        snippetId,
        label: "Terminal",
      });
    } else {
      const path = match[5];
      const isDir = /\/$/.test(path);
      parts.push({ type: "ref", path, isDir });
    }
    last = match.index + match[0].length;
  }
  const tail = normalized.slice(last);
  if (tail) parts.push({ type: "text", value: tail });
  return parts.length > 0 ? parts : [{ type: "text", value: normalized }];
}

export function truncateRefContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n… [truncated, ${content.length - maxChars} chars omitted]`;
}
