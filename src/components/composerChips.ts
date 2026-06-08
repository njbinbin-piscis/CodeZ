import { invoke } from "@tauri-apps/api/core";
import type { PickedElement } from "../services/tauri/browser";
import { browserElementChipLabel, browserElementPlaceholder } from "../services/tauri/browser";
import type { ChatAttachment } from "../services/tauri/chat";

export interface BrowserElementChip {
  id: string;
  kind: "browser-element";
  element: PickedElement;
}

export interface FileRefChip {
  id: string;
  kind: "file-ref";
  path: string;
  isDir: boolean;
}

export interface TerminalSnippetChip {
  id: string;
  kind: "terminal-snippet";
  snippetId: string;
  preview: string;
  lineCount: number;
}

export interface ImageAttachmentChip {
  id: string;
  kind: "image-attachment";
  attachment: ChatAttachment;
  preview: string;
}

export type ComposerChip =
  | BrowserElementChip
  | FileRefChip
  | TerminalSnippetChip
  | ImageAttachmentChip;

export function createBrowserElementChip(element: PickedElement): BrowserElementChip {
  return {
    id: `be-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "browser-element",
    element,
  };
}

export function createFileRefChip(path: string, isDir = false): FileRefChip {
  return {
    id: `fr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "file-ref",
    path,
    isDir,
  };
}

export function createImageAttachmentChip(
  attachment: ChatAttachment,
  preview: string,
): ImageAttachmentChip {
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "image-attachment",
    attachment,
    preview,
  };
}

export function createTerminalSnippetChip(
  snippetId: string,
  preview: string,
  lineCount: number,
): TerminalSnippetChip {
  return {
    id: `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "terminal-snippet",
    snippetId,
    preview,
    lineCount,
  };
}

/** Token stored in session history; backend expands to full context. */
export function fileRefPlaceholder(path: string): string {
  const rel = path.replace(/^[/\\]+/, "");
  return `@${rel}`;
}

export function terminalSnippetPlaceholder(snippetId: string): string {
  return `@terminal-snippet(${snippetId})`;
}

export function chipToPromptToken(chip: ComposerChip): string {
  switch (chip.kind) {
    case "browser-element":
      return browserElementPlaceholder(chip.element);
    case "file-ref":
      return fileRefPlaceholder(chip.path);
    case "terminal-snippet":
      return terminalSnippetPlaceholder(chip.snippetId);
    case "image-attachment":
      return "";
  }
}

export function extractImageAttachment(chips: ComposerChip[]): ChatAttachment | null {
  const img = chips.find((c) => c.kind === "image-attachment");
  return img?.kind === "image-attachment" ? img.attachment : null;
}

export function hasImageAttachment(chips: ComposerChip[]): boolean {
  return chips.some((c) => c.kind === "image-attachment");
}

/** Serialize chips + free text into the prompt sent to the agent. */
export function composePromptWithChips(chips: ComposerChip[], body: string): string {
  const tokens = chips
    .filter((c) => c.kind !== "image-attachment")
    .map((c) => ({ chip: c, token: chipToPromptToken(c) }));
  const refs = tokens
    .map((t) => t.token)
    .filter(Boolean)
    .join(" ");
  const text = body.trim();
  const out = refs && text ? `${refs} ${text}` : refs || text;
  if (import.meta.env.DEV && chips.length > 0) {
    const payload = {
      chipCount: chips.length,
      tokens: tokens.map((t) =>
        t.chip.kind === "file-ref"
          ? { kind: t.chip.kind, path: t.chip.path, isDir: t.chip.isDir, token: t.token }
          : { kind: t.chip.kind, token: t.token },
      ),
      bodyLen: body.length,
      outLen: out.length,
      preview: out.length > 200 ? `${out.slice(0, 200)}…` : out,
    };
    console.log("[AgentZ:composer] composePromptWithChips", payload);
    void invoke("composer_debug_log", {
      line: `[AgentZ:composer] composePromptWithChips ${JSON.stringify(payload)}`,
    }).catch(() => {});
  }
  return out;
}

export function fileRefChipLabel(path: string, isDir: boolean): string {
  const base = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
  return isDir ? `${base}/` : base;
}

type ChipLabelT = (key: string, options?: Record<string, unknown>) => string;

export function chipDisplayLabel(chip: ComposerChip, t?: ChipLabelT): string {
  switch (chip.kind) {
    case "browser-element":
      return browserElementChipLabel(chip.element);
    case "file-ref":
      return fileRefChipLabel(chip.path, chip.isDir);
    case "terminal-snippet":
      if (t) {
        return chip.lineCount > 1
          ? t("chat.chipTerminalLines", { count: chip.lineCount })
          : t("chat.chipTerminalSelection");
      }
      return chip.lineCount > 1 ? `Terminal · ${chip.lineCount} lines` : "Terminal · selection";
    case "image-attachment":
      return chip.attachment.filename ?? (t ? t("chat.chipImage") : "Image");
  }
}
