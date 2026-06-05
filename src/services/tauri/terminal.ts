import { invoke } from "@tauri-apps/api/core";

/** Store a terminal text selection; returns an id for `@terminal-snippet(id)`. */
export function terminalSnippetPut(text: string): Promise<string> {
  return invoke<string>("terminal_snippet_put", { text });
}

/** Read recent terminal output (agent / debugging). */
export function terminalRead(args: {
  terminalId?: string | null;
  lines?: number;
  grep?: string | null;
  grepLines?: number;
}): Promise<string> {
  return invoke<string>("ide_terminal_read", {
    terminalId: args.terminalId ?? null,
    lines: args.lines ?? 50,
    grep: args.grep ?? null,
    grepLines: args.grepLines ?? 100,
  });
}
