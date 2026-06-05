// Clean-room implementations of the concrete vscode.* runtime types extensions
// instantiate (Position, Range, Uri, CompletionItem, ...). Positions are
// 0-indexed, matching the VS Code API contract.

import * as dto from "../common/dto";

export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
    });
  }
  private callback: (() => unknown) | undefined;
  constructor(callback: () => unknown) {
    this.callback = callback;
  }
  dispose(): void {
    if (this.callback) {
      this.callback();
      this.callback = undefined;
    }
  }
}

export interface Event<T> {
  (listener: (e: T) => unknown): Disposable;
}

export class EventEmitter<T> {
  private listeners: ((e: T) => unknown)[] = [];
  readonly event: Event<T> = (listener) => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    });
  };
  fire(data: T): void {
    for (const l of this.listeners.slice()) {
      try {
        l(data);
      } catch {
        /* swallow listener errors */
      }
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  private _cancelled = false;
  readonly token = {
    get isCancellationRequested() {
      return false;
    },
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this.emitter.fire();
    }
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export class Uri implements dto.UriComponents {
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(value);
    if (!m) return new Uri("file", "", value, "", "");
    return new Uri(m[1] || "", m[3] || "", m[4] || "", m[6] || "", m[8] || "");
  }
  static file(path: string): Uri {
    let p = path.replace(/\\/g, "/");
    if (p[0] !== "/") p = "/" + p;
    return new Uri("file", "", p, "", "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const path = [base.path.replace(/\/$/, ""), ...segments].join("/");
    return base.with({ path });
  }
  static from(c: dto.UriComponents): Uri {
    return new Uri(c.scheme, c.authority ?? "", c.path, c.query ?? "", c.fragment ?? "");
  }
  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    let r = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) r += `?${this.query}`;
    if (this.fragment) r += `#${this.fragment}`;
    return r;
  }
  toJSON(): dto.UriComponents {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startChar: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
  }
  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

export class Selection extends Range {
  constructor(
    public readonly anchor: Position,
    public readonly active: Position,
  ) {
    super(anchor, active);
  }
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export class MarkdownString {
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  constructor(public value = "") {}
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(code: string, lang = ""): MarkdownString {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export enum CompletionItemKind {
  Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4, Variable = 5,
  Class = 6, Interface = 7, Module = 8, Property = 9, Unit = 10, Value = 11,
  Enum = 12, Keyword = 13, Snippet = 14, Color = 15, File = 16, Reference = 17,
  Folder = 18, EnumMember = 19, Constant = 20, Struct = 21, Event = 22,
  Operator = 23, TypeParameter = 24,
}

export class CompletionItem {
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  insertText?: string | SnippetString;
  range?: Range;
  commitCharacters?: string[];
  preselect?: boolean;
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class CompletionList {
  constructor(public items: CompletionItem[] = [], public isIncomplete = false) {}
}

export class SnippetString {
  constructor(public value = "") {}
  appendText(s: string): SnippetString {
    this.value += s;
    return this;
  }
  appendTabstop(n = 0): SnippetString {
    this.value += `$${n}`;
    return this;
  }
  appendPlaceholder(s: string, n = 0): SnippetString {
    this.value += `\${${n}:${s}}`;
    return this;
  }
}

export class Hover {
  contents: (MarkdownString | string)[];
  constructor(contents: MarkdownString | string | (MarkdownString | string)[], public range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class DiagnosticRelatedInformation {
  constructor(public location: Location, public message: string) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(public range: Range, public message: string, public severity = DiagnosticSeverity.Error) {}
}

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
  constructor(public range: Range, public newText: string) {}
}

export class WorkspaceEdit {
  private map = new Map<string, TextEdit[]>();
  replace(uri: Uri, range: Range, newText: string): void {
    this.push(uri, new TextEdit(range, newText));
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this.push(uri, TextEdit.insert(position, newText));
  }
  delete(uri: Uri, range: Range): void {
    this.push(uri, TextEdit.delete(range));
  }
  private push(uri: Uri, edit: TextEdit): void {
    const key = uri.toString();
    const arr = this.map.get(key) ?? [];
    arr.push(edit);
    this.map.set(key, arr);
  }
  entries(): [Uri, TextEdit[]][] {
    return [...this.map.entries()].map(([k, v]) => [Uri.parse(k), v]);
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  constructor(public readonly value: string) {}
  append(parts: string): CodeActionKind {
    return new CodeActionKind(`${this.value}.${parts}`);
  }
}

export class CodeAction {
  kind?: CodeActionKind;
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: { command: string; title: string; arguments?: unknown[] };
  isPreferred?: boolean;
  constructor(public title: string, kind?: CodeActionKind) {
    this.kind = kind;
  }
}

export enum SymbolKind {
  File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5,
  Property = 6, Field = 7, Constructor = 8, Enum = 9, Interface = 10,
  Function = 11, Variable = 12, Constant = 13, String = 14, Number = 15,
  Boolean = 16, Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21,
  Struct = 22, Event = 23, Operator = 24, TypeParameter = 25,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  detail = "";
  constructor(public name: string, detail: string, public kind: SymbolKind, public range: Range, public selectionRange: Range) {
    this.detail = detail;
  }
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}
export class SignatureInformation {
  parameters: ParameterInformation[] = [];
  documentation?: string | MarkdownString;
  constructor(public label: string, documentation?: string | MarkdownString) {
    this.documentation = documentation;
  }
}
export class ParameterInformation {
  constructor(public label: string, public documentation?: string | MarkdownString) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon | Uri | string;
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;
  resourceUri?: Uri;
  id?: string;
  collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None;
  constructor(label: string | { label: string }, collapsibleState?: TreeItemCollapsibleState) {
    if (typeof label === "string") this.label = label;
    else this.label = label.label;
    if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
  }
}

export class RelativePattern {
  constructor(public base: string | Uri, public pattern: string) {}
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
