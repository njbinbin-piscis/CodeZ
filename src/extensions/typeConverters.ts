// Converters between the wire DTOs (vscode conventions, 0-indexed) and Monaco's
// editor model types (1-indexed, different enum numbering).

import * as monaco from "monaco-editor";
import type * as dto from "./common/dto";

export function toMonacoRange(r: dto.IRange): monaco.IRange {
  return {
    startLineNumber: r.startLine + 1,
    startColumn: r.startCharacter + 1,
    endLineNumber: r.endLine + 1,
    endColumn: r.endCharacter + 1,
  };
}

export function fromMonacoRange(r: monaco.IRange): dto.IRange {
  return {
    startLine: r.startLineNumber - 1,
    startCharacter: r.startColumn - 1,
    endLine: r.endLineNumber - 1,
    endCharacter: r.endColumn - 1,
  };
}

export function toDtoPosition(p: monaco.Position): dto.IPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function uriToDto(uri: monaco.Uri): dto.UriComponents {
  return {
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment,
  };
}

export function dtoToUri(c: dto.UriComponents): monaco.Uri {
  return monaco.Uri.from({
    scheme: c.scheme,
    authority: c.authority,
    path: c.path,
    query: c.query,
    fragment: c.fragment,
  });
}

function markdownToString(value: string | dto.MarkdownStringDto): monaco.IMarkdownString | string {
  if (typeof value === "string") return { value };
  return { value: value.value, isTrusted: value.isTrusted, supportThemeIcons: value.supportThemeIcons };
}

// vscode CompletionItemKind -> monaco.languages.CompletionItemKind
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  0: monaco.languages.CompletionItemKind.Text,
  1: monaco.languages.CompletionItemKind.Method,
  2: monaco.languages.CompletionItemKind.Function,
  3: monaco.languages.CompletionItemKind.Constructor,
  4: monaco.languages.CompletionItemKind.Field,
  5: monaco.languages.CompletionItemKind.Variable,
  6: monaco.languages.CompletionItemKind.Class,
  7: monaco.languages.CompletionItemKind.Interface,
  8: monaco.languages.CompletionItemKind.Module,
  9: monaco.languages.CompletionItemKind.Property,
  10: monaco.languages.CompletionItemKind.Unit,
  11: monaco.languages.CompletionItemKind.Value,
  12: monaco.languages.CompletionItemKind.Enum,
  13: monaco.languages.CompletionItemKind.Keyword,
  14: monaco.languages.CompletionItemKind.Snippet,
  15: monaco.languages.CompletionItemKind.Color,
  16: monaco.languages.CompletionItemKind.File,
  17: monaco.languages.CompletionItemKind.Reference,
  18: monaco.languages.CompletionItemKind.Folder,
  19: monaco.languages.CompletionItemKind.EnumMember,
  20: monaco.languages.CompletionItemKind.Constant,
  21: monaco.languages.CompletionItemKind.Struct,
  22: monaco.languages.CompletionItemKind.Event,
  23: monaco.languages.CompletionItemKind.Operator,
  24: monaco.languages.CompletionItemKind.TypeParameter,
};

export function toMonacoCompletion(
  item: dto.CompletionItemDto,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionItem {
  const kind = item.kind !== undefined ? COMPLETION_KIND[item.kind] ?? monaco.languages.CompletionItemKind.Text : monaco.languages.CompletionItemKind.Text;
  return {
    label: item.label,
    kind,
    detail: item.detail,
    documentation: item.documentation ? markdownToString(item.documentation) : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: item.insertText ?? item.label,
    insertTextRules: item.insertTextIsSnippet
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    range: item.range ? toMonacoRange(item.range) : defaultRange,
    commitCharacters: item.commitCharacters,
    preselect: item.preselect,
  };
}

export function toMonacoHover(hover: dto.HoverDto): monaco.languages.Hover {
  return {
    contents: hover.contents.map((c) => markdownToString(c)) as monaco.IMarkdownString[],
    range: hover.range ? toMonacoRange(hover.range) : undefined,
  };
}

export function toMonacoLocation(loc: dto.LocationDto): monaco.languages.Location {
  return { uri: dtoToUri(loc.uri), range: toMonacoRange(loc.range) };
}

// vscode DiagnosticSeverity (Error=0,Warning=1,Info=2,Hint=3) -> MarkerSeverity
const MARKER_SEVERITY: Record<number, monaco.MarkerSeverity> = {
  0: monaco.MarkerSeverity.Error,
  1: monaco.MarkerSeverity.Warning,
  2: monaco.MarkerSeverity.Info,
  3: monaco.MarkerSeverity.Hint,
};

export function toMonacoMarker(d: dto.DiagnosticDto): monaco.editor.IMarkerData {
  const r = toMonacoRange(d.range);
  return {
    severity: MARKER_SEVERITY[d.severity] ?? monaco.MarkerSeverity.Error,
    message: d.message,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    startLineNumber: r.startLineNumber,
    startColumn: r.startColumn,
    endLineNumber: r.endLineNumber,
    endColumn: r.endColumn,
  };
}

export function toMonacoTextEdit(e: dto.TextEditDto): monaco.languages.TextEdit {
  return { range: toMonacoRange(e.range), text: e.text };
}

// vscode SymbolKind numbering matches monaco.languages.SymbolKind 1:1.
export function toMonacoDocumentSymbol(s: dto.DocumentSymbolDto): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? "",
    kind: s.kind as monaco.languages.SymbolKind,
    tags: [],
    range: toMonacoRange(s.range),
    selectionRange: toMonacoRange(s.selectionRange),
    children: s.children?.map(toMonacoDocumentSymbol),
  };
}
