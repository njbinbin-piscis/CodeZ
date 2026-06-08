import { invoke } from "@tauri-apps/api/core";
import type { ComposerChip } from "../components/composerChips";

/** Dev-only composer / chip pipeline logging — filter console with `AgentZ:composer`. */
const ENABLED = import.meta.env.DEV;

function persistLine(line: string): void {
  if (!ENABLED) return;
  // Fire-and-forget — must survive UI black-screen freezes.
  void invoke("composer_debug_log", { line }).catch(() => {});
}

export function composerDbg(label: string, data?: unknown): void {
  if (!ENABLED) return;
  const ts = performance.now().toFixed(1);
  const msg =
    data !== undefined
      ? `[AgentZ:composer][${ts}ms] ${label} ${JSON.stringify(data)}`
      : `[AgentZ:composer][${ts}ms] ${label}`;
  console.log(msg);
  persistLine(msg);
}

export function composerDbgMark(label: string): () => void {
  if (!ENABLED) return () => {};
  const t0 = performance.now();
  composerDbg(`→ ${label}`);
  return () => composerDbg(`← ${label} (+${(performance.now() - t0).toFixed(1)}ms)`);
}

export function chipsSnapshot(chips: ComposerChip[]) {
  return chips.map((c) => {
    switch (c.kind) {
      case "file-ref":
        return { kind: c.kind, id: c.id, path: c.path, isDir: c.isDir };
      case "browser-element":
        return { kind: c.kind, id: c.id, selector: c.element.selector };
      case "terminal-snippet":
        return { kind: c.kind, id: c.id, snippetId: c.snippetId, lines: c.lineCount };
      case "image-attachment":
        return {
          kind: c.kind,
          id: c.id,
          media: c.attachment.media_type,
          filename: c.attachment.filename,
        };
    }
  });
}

export function promptPreview(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}
