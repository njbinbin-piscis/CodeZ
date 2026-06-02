/** Cmd-K inline edit IPC — single-shot LLM transform of a selection. */
import { invoke } from "@tauri-apps/api/core";

export function inlineEdit(args: {
  instruction: string;
  selection: string;
  language?: string | null;
  beforeContext?: string | null;
  afterContext?: string | null;
}): Promise<string> {
  return invoke<string>("inline_edit", {
    instruction: args.instruction,
    selection: args.selection,
    language: args.language ?? null,
    beforeContext: args.beforeContext ?? null,
    afterContext: args.afterContext ?? null,
  });
}

/** Low-latency Tab / ghost-text completion (M5). Returns "" when unconfigured. */
export function aiInlineCompletion(args: {
  prefix: string;
  suffix: string;
  language?: string | null;
  modelId?: string | null;
}): Promise<string> {
  return invoke<string>("ai_inline_completion", {
    prefix: args.prefix,
    suffix: args.suffix,
    language: args.language ?? null,
    modelId: args.modelId ?? null,
  });
}
