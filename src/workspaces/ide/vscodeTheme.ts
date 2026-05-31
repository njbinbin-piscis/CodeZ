/** Convert VS Code declarative contributions (themes, snippets) into the shapes
 *  Monaco understands. Pure data — no extension JS is ever executed. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Tolerant JSON(C) parse: strips comments + trailing commas (theme/snippet
 *  files are routinely JSONC). */
export function parseJsonc(text: string): Json {
  let t = text.replace(/^\uFEFF/, "");
  // Strip block comments, then line comments, avoiding URLs by requiring the
  // // not be preceded by a colon is overkill here; theme files don't contain
  // raw `://` outside strings often — keep it simple and robust enough.
  t = t.replace(/\/\*[\s\S]*?\*\//g, "");
  t = t.replace(/(^|[^:])\/\/.*$/gm, "$1");
  t = t.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(t);
}

const stripHash = (c?: string) => (c ? c.replace(/^#/, "") : undefined);

// Workbench color ids Monaco's standalone theme accepts. Unknown keys make
// defineTheme throw, so we whitelist the common, safe ones.
const SAFE_COLOR_KEYS = new Set([
  "editor.background",
  "editor.foreground",
  "editorCursor.foreground",
  "editor.lineHighlightBackground",
  "editor.lineHighlightBorder",
  "editorLineNumber.foreground",
  "editorLineNumber.activeForeground",
  "editor.selectionBackground",
  "editor.selectionHighlightBackground",
  "editor.inactiveSelectionBackground",
  "editor.wordHighlightBackground",
  "editorWhitespace.foreground",
  "editorIndentGuide.background",
  "editorIndentGuide.activeBackground",
  "editorCursor.background",
  "editor.findMatchBackground",
  "editor.findMatchHighlightBackground",
  "editorBracketMatch.background",
  "editorBracketMatch.border",
  "editorGutter.background",
]);

export interface MonacoTheme {
  base: "vs" | "vs-dark" | "hc-black";
  inherit: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: any[];
  colors: Record<string, string>;
}

/**
 * Convert a VS Code color-theme JSON into a Monaco theme definition.
 *
 * Note: TextMate scopes (`tokenColors[].scope`) only partially line up with
 * Monaco's tokenizer token types, so syntax colors are approximate; the
 * workbench `colors` (background/foreground/cursor/etc.) apply faithfully and
 * carry the dominant look.
 */
export function vscodeThemeToMonaco(themeJson: string, uiTheme?: string): MonacoTheme {
  const data = parseJsonc(themeJson);
  const type: string = data.type || "";
  let base: MonacoTheme["base"] = "vs-dark";
  if (uiTheme === "vs" || type === "light") base = "vs";
  else if (uiTheme === "hc-black" || type === "hc") base = "hc-black";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules: any[] = [];
  const tokenColors: Json[] = Array.isArray(data.tokenColors) ? data.tokenColors : [];
  for (const tc of tokenColors) {
    const settings = tc?.settings;
    if (!settings) continue;
    const fg = stripHash(settings.foreground);
    const bg = stripHash(settings.background);
    const fontStyle: string | undefined = settings.fontStyle;
    if (!fg && !bg && !fontStyle) continue;
    const scopes: string[] = Array.isArray(tc.scope)
      ? tc.scope
      : typeof tc.scope === "string"
        ? tc.scope.split(",").map((s: string) => s.trim())
        : [""];
    for (const scope of scopes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = { token: scope };
      if (fg) rule.foreground = fg;
      if (bg) rule.background = bg;
      if (fontStyle) rule.fontStyle = fontStyle;
      rules.push(rule);
    }
  }

  const colors: Record<string, string> = {};
  const srcColors = data.colors || {};
  for (const key of Object.keys(srcColors)) {
    if (SAFE_COLOR_KEYS.has(key) && typeof srcColors[key] === "string") {
      colors[key] = srcColors[key];
    }
  }

  return { base, inherit: true, rules, colors };
}

export interface SnippetItem {
  prefix: string;
  body: string;
  description?: string;
}

/** Parse a VS Code snippet file into flat snippet items. */
export function parseSnippets(snippetJson: string): SnippetItem[] {
  const data = parseJsonc(snippetJson);
  const out: SnippetItem[] = [];
  for (const key of Object.keys(data)) {
    const s = data[key];
    if (!s || typeof s !== "object") continue;
    const prefixes: string[] = Array.isArray(s.prefix) ? s.prefix : s.prefix ? [s.prefix] : [];
    const body = Array.isArray(s.body) ? s.body.join("\n") : String(s.body ?? "");
    for (const prefix of prefixes) {
      out.push({ prefix, body, description: s.description });
    }
  }
  return out;
}
