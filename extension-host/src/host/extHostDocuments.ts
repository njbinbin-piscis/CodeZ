// ExtHostDocuments: mirrors the renderer's open Monaco models as vscode
// TextDocument objects and keeps them in sync via $acceptModel* RPC callbacks.

import * as dto from "../common/dto";
import { ExtHostDocumentsShape } from "../common/protocol";
import { EventEmitter, Position, Range, Uri, EndOfLine } from "./types-impl";

export class TextDocument {
  _lines: string[];
  _eol: string;
  version: number;
  constructor(
    public readonly uri: Uri,
    public languageId: string,
    version: number,
    lines: string[],
    eol: string,
  ) {
    this.version = version;
    this._lines = lines;
    this._eol = eol;
  }
  get fileName(): string {
    return this.uri.fsPath;
  }
  get isUntitled(): boolean {
    return this.uri.scheme === "untitled";
  }
  get isDirty(): boolean {
    return false;
  }
  get isClosed(): boolean {
    return false;
  }
  get eol(): EndOfLine {
    return this._eol === "\r\n" ? EndOfLine.CRLF : EndOfLine.LF;
  }
  get lineCount(): number {
    return this._lines.length;
  }
  getText(range?: Range): string {
    if (!range) return this._lines.join(this._eol);
    const out: string[] = [];
    for (let i = range.start.line; i <= range.end.line && i < this._lines.length; i++) {
      const line = this._lines[i] ?? "";
      if (i === range.start.line && i === range.end.line) out.push(line.slice(range.start.character, range.end.character));
      else if (i === range.start.line) out.push(line.slice(range.start.character));
      else if (i === range.end.line) out.push(line.slice(0, range.end.character));
      else out.push(line);
    }
    return out.join(this._eol);
  }
  lineAt(lineOrPos: number | Position): { lineNumber: number; text: string; range: Range; isEmptyOrWhitespace: boolean } {
    const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
    const text = this._lines[line] ?? "";
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      isEmptyOrWhitespace: text.trim().length === 0,
    };
  }
  offsetAt(position: Position): number {
    let offset = 0;
    for (let i = 0; i < position.line && i < this._lines.length; i++) {
      offset += (this._lines[i] ?? "").length + this._eol.length;
    }
    return offset + position.character;
  }
  positionAt(offset: number): Position {
    let remaining = offset;
    for (let i = 0; i < this._lines.length; i++) {
      const len = (this._lines[i] ?? "").length + this._eol.length;
      if (remaining < len) return new Position(i, remaining);
      remaining -= len;
    }
    const last = this._lines.length - 1;
    return new Position(Math.max(0, last), (this._lines[last] ?? "").length);
  }
  getWordRangeAtPosition(position: Position): Range | undefined {
    const line = this._lines[position.line] ?? "";
    const re = /[A-Za-z0-9_$]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index <= position.character && position.character <= m.index + m[0].length) {
        return new Range(position.line, m.index, position.line, m.index + m[0].length);
      }
    }
    return undefined;
  }
  validatePosition(p: Position): Position {
    return p;
  }
  validateRange(r: Range): Range {
    return r;
  }
  save(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export class ExtHostDocuments implements ExtHostDocumentsShape {
  private readonly documents = new Map<string, TextDocument>();
  private _activeUri: string | undefined;

  readonly onDidOpenEmitter = new EventEmitter<TextDocument>();
  readonly onDidCloseEmitter = new EventEmitter<TextDocument>();
  readonly onDidChangeEmitter = new EventEmitter<{ document: TextDocument; contentChanges: unknown[] }>();
  readonly onDidChangeActiveEmitter = new EventEmitter<TextDocument | undefined>();

  all(): TextDocument[] {
    return [...this.documents.values()];
  }

  getDocument(uri: dto.UriComponents): TextDocument | undefined {
    return this.documents.get(Uri.from(uri).toString());
  }

  getActiveDocument(): TextDocument | undefined {
    return this._activeUri ? this.documents.get(this._activeUri) : undefined;
  }

  $acceptModelOpened(model: dto.DocumentModelDto): void {
    const uri = Uri.from(model.uri);
    const doc = new TextDocument(uri, model.languageId, model.versionId, model.lines, model.eol);
    this.documents.set(uri.toString(), doc);
    this.onDidOpenEmitter.fire(doc);
  }

  $acceptModelChanged(event: dto.ModelChangedEventDto): void {
    const key = Uri.from(event.uri).toString();
    const doc = this.documents.get(key);
    if (!doc) return;
    doc.version = event.versionId;
    doc._eol = event.eol;
    // Re-apply the full text from changes when a single full-replace arrives,
    // otherwise patch line ranges.
    for (const change of event.changes) {
      applyChange(doc, change.range, change.text);
    }
    this.onDidChangeEmitter.fire({ document: doc, contentChanges: event.changes });
  }

  $acceptModelClosed(uri: dto.UriComponents): void {
    const key = Uri.from(uri).toString();
    const doc = this.documents.get(key);
    if (doc) {
      this.documents.delete(key);
      this.onDidCloseEmitter.fire(doc);
    }
  }

  $acceptActiveEditorChanged(uri: dto.UriComponents | undefined): void {
    this._activeUri = uri ? Uri.from(uri).toString() : undefined;
    this.onDidChangeActiveEmitter.fire(this.getActiveDocument());
  }
}

function applyChange(doc: TextDocument, range: dto.IRange, text: string): void {
  const before = doc._lines.slice(0, range.startLine);
  const after = doc._lines.slice(range.endLine + 1);
  const startLine = doc._lines[range.startLine] ?? "";
  const endLine = doc._lines[range.endLine] ?? "";
  const head = startLine.slice(0, range.startCharacter);
  const tail = endLine.slice(range.endCharacter);
  const inserted = (head + text + tail).split(/\r\n|\n/);
  doc._lines = [...before, ...inserted, ...after];
}
