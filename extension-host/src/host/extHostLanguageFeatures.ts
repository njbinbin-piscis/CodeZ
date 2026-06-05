// ExtHostLanguageFeatures: registers vscode.languages.* providers and answers
// the renderer's $provideX RPC calls by invoking them against the synced docs.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import {
  ExtHostLanguageFeaturesShape,
  MainContext,
  MainThreadLanguageFeaturesShape,
} from "../common/protocol";
import { ExtHostCommands } from "./extHostCommands";
import { ExtHostDocuments } from "./extHostDocuments";
import * as conv from "./converters";
import * as types from "./types-impl";

const NONE = new types.CancellationTokenSource().token;

interface DocumentSelectorLike {
  language?: string;
  scheme?: string;
  pattern?: string;
}
type DocumentSelector = string | DocumentSelectorLike | (string | DocumentSelectorLike)[];

function selectorToLanguages(selector: DocumentSelector): string[] {
  const arr = Array.isArray(selector) ? selector : [selector];
  return arr.map((s) => (typeof s === "string" ? s : s.language ?? "*")).filter(Boolean);
}

export class ExtHostLanguageFeatures implements ExtHostLanguageFeaturesShape {
  private readonly proxy: MainThreadLanguageFeaturesShape;
  private nextHandle = 0;
  private readonly providers = new Map<number, unknown>();

  constructor(
    rpc: IRPCProtocol,
    private readonly documents: ExtHostDocuments,
    private readonly commands: ExtHostCommands,
  ) {
    this.proxy = rpc.getProxy(MainContext.MainThreadLanguageFeatures);
  }

  private register(provider: unknown): number {
    const handle = this.nextHandle++;
    this.providers.set(handle, provider);
    return handle;
  }

  private disposable(handle: number): types.Disposable {
    return new types.Disposable(() => {
      this.providers.delete(handle);
      this.proxy.$unregister(handle);
    });
  }

  private docFor(uri: dto.UriComponents) {
    const doc = this.documents.getDocument(uri);
    if (!doc) throw new Error(`document not open: ${uri.path}`);
    return doc;
  }

  // ── registration API (called by apiFactory) ──────────────────────────────

  registerCompletionItemProvider(selector: DocumentSelector, provider: any, triggerCharacters: string[]): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerCompletionSupport(handle, selectorToLanguages(selector), triggerCharacters);
    return this.disposable(handle);
  }
  registerHoverProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerHoverProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerDefinitionProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerDefinitionProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerReferenceProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerReferenceProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerDocumentHighlightProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerDocumentHighlightProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerDocumentSymbolProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerDocumentSymbolProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerFormattingProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerCodeActionsProvider(selector: DocumentSelector, provider: any): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerCodeActionProvider(handle, selectorToLanguages(selector));
    return this.disposable(handle);
  }
  registerSignatureHelpProvider(selector: DocumentSelector, provider: any, triggerCharacters: string[]): types.Disposable {
    const handle = this.register(provider);
    this.proxy.$registerSignatureHelpProvider(handle, selectorToLanguages(selector), triggerCharacters);
    return this.disposable(handle);
  }

  // ── RPC: provider invocation ──────────────────────────────────────────────

  async $provideCompletionItems(handle: number, uri: dto.UriComponents, position: dto.IPosition, triggerCharacter?: string): Promise<dto.CompletionListDto | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideCompletionItems) return undefined;
    const doc = this.docFor(uri);
    const ctx = { triggerKind: triggerCharacter ? 1 : 0, triggerCharacter };
    const result = await provider.provideCompletionItems(doc, conv.toPosition(position), NONE, ctx);
    if (!result) return undefined;
    const items = Array.isArray(result) ? result : result.items;
    const isIncomplete = Array.isArray(result) ? false : !!result.isIncomplete;
    return { isIncomplete, items: items.map((i: types.CompletionItem) => conv.fromCompletionItem(i)) };
  }

  async $provideHover(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.HoverDto | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideHover) return undefined;
    const result = await provider.provideHover(this.docFor(uri), conv.toPosition(position), NONE);
    return result ? conv.fromHover(result) : undefined;
  }

  async $provideDefinition(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.LocationDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideDefinition) return undefined;
    const result = await provider.provideDefinition(this.docFor(uri), conv.toPosition(position), NONE);
    return normalizeLocations(result);
  }

  async $provideReferences(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.LocationDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideReferences) return undefined;
    const result = await provider.provideReferences(this.docFor(uri), conv.toPosition(position), { includeDeclaration: true }, NONE);
    return normalizeLocations(result);
  }

  async $provideDocumentHighlights(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.DocumentHighlightDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideDocumentHighlights) return undefined;
    const result = await provider.provideDocumentHighlights(this.docFor(uri), conv.toPosition(position), NONE);
    if (!result) return undefined;
    return result.map((h: any) => ({ range: conv.fromRange(h.range), kind: h.kind }));
  }

  async $provideDocumentSymbols(handle: number, uri: dto.UriComponents): Promise<dto.DocumentSymbolDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideDocumentSymbols) return undefined;
    const result = await provider.provideDocumentSymbols(this.docFor(uri), NONE);
    if (!result) return undefined;
    return result.map((s: types.DocumentSymbol) => conv.fromDocumentSymbol(s));
  }

  async $provideDocumentFormattingEdits(handle: number, uri: dto.UriComponents): Promise<dto.TextEditDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideDocumentFormattingEdits) return undefined;
    const opts = { tabSize: 2, insertSpaces: true };
    const result = await provider.provideDocumentFormattingEdits(this.docFor(uri), opts, NONE);
    if (!result) return undefined;
    return result.map((e: types.TextEdit) => conv.fromTextEdit(e));
  }

  async $provideCodeActions(handle: number, uri: dto.UriComponents, range: dto.IRange): Promise<dto.CodeActionDto[] | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideCodeActions) return undefined;
    const ctx = { diagnostics: [], only: undefined, triggerKind: 1 };
    const result = await provider.provideCodeActions(this.docFor(uri), conv.toRange(range), ctx, NONE);
    if (!result) return undefined;
    return result
      .map((a: any) => (a instanceof types.CodeAction ? conv.fromCodeAction(a) : a.command ? conv.fromCodeAction(Object.assign(new types.CodeAction(a.title), a)) : undefined))
      .filter(Boolean);
  }

  async $provideSignatureHelp(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.SignatureHelpDto | undefined> {
    const provider = this.providers.get(handle) as any;
    if (!provider?.provideSignatureHelp) return undefined;
    const ctx = { triggerKind: 1, isRetrigger: false };
    const result = await provider.provideSignatureHelp(this.docFor(uri), conv.toPosition(position), NONE, ctx);
    return result ? conv.fromSignatureHelp(result) : undefined;
  }
}

function normalizeLocations(result: unknown): dto.LocationDto[] | undefined {
  if (!result) return undefined;
  const arr = Array.isArray(result) ? result : [result];
  return arr
    .map((l: any) => {
      if (l instanceof types.Location) return conv.fromLocation(l);
      if (l.targetUri && l.targetRange) return { uri: l.targetUri.toJSON(), range: conv.fromRange(l.targetRange) };
      return undefined;
    })
    .filter(Boolean) as dto.LocationDto[];
}
