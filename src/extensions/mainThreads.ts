// MainThread* implementations: the renderer side of the protocol. Each binds an
// extension capability to Monaco and/or the Tauri host, delegating provider
// callbacks back to the extension host via ExtHost* proxies.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";

import type { IRPCProtocol } from "./common/proxyIdentifier";
import {
  ExtHostContext,
  MainContext,
  type InitDataDto,
  type MainThreadCommandsShape,
  type MainThreadDebugShape,
  type MainThreadDiagnosticsShape,
  type MainThreadEditorsShape,
  type MainThreadLanguageFeaturesShape,
  type MainThreadMessageServiceShape,
  type MainThreadNotebookShape,
  type MainThreadOutputShape,
  type MainThreadQuickOpenShape,
  type MainThreadScmShape,
  type MainThreadStatusBarShape,
  type MainThreadTaskShape,
  type MainThreadTerminalShape,
  type MainThreadTestingShape,
  type MainThreadTreeViewsShape,
  type MainThreadWebviewsShape,
  type MainThreadWorkspaceShape,
} from "./common/protocol";
import type {
  DiagnosticDto,
  IRange,
  QuickPickItemDto,
  ScmGroupDto,
  StatusBarEntryDto,
  TaskDto,
  TestItemDto,
  TreeItemDto,
  UriComponents,
  WebviewPanelDto,
  WorkspaceEditDto,
  DebugConfigurationDto,
} from "./common/dto";
import * as conv from "./typeConverters";
import { extensionUiStore } from "./extensionUiStore";

export interface MainThreadContext {
  rpc: IRPCProtocol;
  projectDir: string;
  /** Persisted extension configuration (settings.json-like). */
  config: Record<string, unknown>;
  saveConfig: (config: Record<string, unknown>) => void;
}

// ── Commands ────────────────────────────────────────────────────────────────

export class MainThreadCommands implements MainThreadCommandsShape {
  private readonly registered = new Set<string>();
  private readonly extHost;
  constructor(rpc: IRPCProtocol) {
    this.extHost = rpc.getProxy(ExtHostContext.ExtHostCommands);
  }
  $registerCommand(id: string): void {
    this.registered.add(id);
  }
  $unregisterCommand(id: string): void {
    this.registered.delete(id);
  }
  async $executeCommand(id: string, args: unknown[]): Promise<unknown> {
    return this.execute(id, args);
  }
  /** Execute a command id (used by UI: tree items, status bar, menus). */
  async execute(id: string, args: unknown[] = []): Promise<unknown> {
    if (this.registered.has(id)) {
      return this.extHost.$executeContributedCommand(id, args);
    }
    return this.builtin(id, args);
  }
  list(): string[] {
    return [...this.registered];
  }
  private builtin(id: string, args: unknown[]): unknown {
    // A small set of workbench built-ins extensions commonly call.
    switch (id) {
      case "setContext":
        return undefined;
      case "vscode.open":
      case "revealLine":
      case "workbench.action.files.save":
        return undefined;
      default:
        console.debug("[ext] unhandled builtin command", id, args);
        return undefined;
    }
  }
}

// ── Language features ─────────────────────────────────────────────────────────

export class MainThreadLanguageFeatures implements MainThreadLanguageFeaturesShape {
  private readonly extHost;
  private readonly disposables = new Map<number, monaco.IDisposable>();
  constructor(rpc: IRPCProtocol) {
    this.extHost = rpc.getProxy(ExtHostContext.ExtHostLanguageFeatures);
  }
  private store(handle: number, d: monaco.IDisposable): void {
    this.disposables.set(handle, d);
  }
  private defaultRange(model: monaco.editor.ITextModel, position: monaco.Position): monaco.IRange {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
  }

  $registerCompletionSupport(handle: number, selector: string[], triggerCharacters: string[]): void {
    const d = monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters,
      provideCompletionItems: async (model, position) => {
        const list = await this.extHost.$provideCompletionItems(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position), undefined);
        if (!list) return { suggestions: [] };
        const range = this.defaultRange(model, position);
        return { suggestions: list.items.map((i) => conv.toMonacoCompletion(i, range)), incomplete: list.isIncomplete };
      },
    });
    this.store(handle, d);
  }
  $registerHoverProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerHoverProvider(selector, {
      provideHover: async (model, position) => {
        const hover = await this.extHost.$provideHover(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position));
        return hover ? conv.toMonacoHover(hover) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerDefinitionProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (model, position) => {
        const locs = await this.extHost.$provideDefinition(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position));
        return locs ? locs.map(conv.toMonacoLocation) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerReferenceProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerReferenceProvider(selector, {
      provideReferences: async (model, position) => {
        const locs = await this.extHost.$provideReferences(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position));
        return locs ? locs.map(conv.toMonacoLocation) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerDocumentHighlightProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerDocumentHighlightProvider(selector, {
      provideDocumentHighlights: async (model, position) => {
        const hls = await this.extHost.$provideDocumentHighlights(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position));
        return hls ? hls.map((h) => ({ range: conv.toMonacoRange(h.range), kind: h.kind as monaco.languages.DocumentHighlightKind })) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerDocumentSymbolProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: async (model) => {
        const syms = await this.extHost.$provideDocumentSymbols(handle, conv.uriToDto(model.uri));
        return syms ? syms.map(conv.toMonacoDocumentSymbol) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerFormattingProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits: async (model) => {
        const edits = await this.extHost.$provideDocumentFormattingEdits(handle, conv.uriToDto(model.uri));
        return edits ? edits.map(conv.toMonacoTextEdit) : undefined;
      },
    });
    this.store(handle, d);
  }
  $registerCodeActionProvider(handle: number, selector: string[]): void {
    const d = monaco.languages.registerCodeActionProvider(selector, {
      provideCodeActions: async (model, range) => {
        const actions = await this.extHost.$provideCodeActions(handle, conv.uriToDto(model.uri), conv.fromMonacoRange(range));
        if (!actions) return { actions: [], dispose: () => undefined };
        return {
          actions: actions.map((a) => ({
            title: a.title,
            kind: a.kind,
            isPreferred: a.isPreferred,
            edit: a.edit ? this.toMonacoWorkspaceEdit(a.edit) : undefined,
            command: a.command ? { id: a.command.id, title: a.command.title, arguments: a.command.arguments } : undefined,
          })),
          dispose: () => undefined,
        };
      },
    });
    this.store(handle, d);
  }
  $registerSignatureHelpProvider(handle: number, selector: string[], triggerCharacters: string[]): void {
    const d = monaco.languages.registerSignatureHelpProvider(selector, {
      signatureHelpTriggerCharacters: triggerCharacters,
      provideSignatureHelp: async (model, position) => {
        const help = await this.extHost.$provideSignatureHelp(handle, conv.uriToDto(model.uri), conv.toDtoPosition(position));
        if (!help) return undefined;
        return {
          value: {
            signatures: help.signatures.map((s) => ({
              label: s.label,
              documentation: typeof s.documentation === "string" ? s.documentation : s.documentation?.value,
              parameters: s.parameters.map((p) => ({ label: p.label, documentation: p.documentation })),
            })),
            activeSignature: help.activeSignature,
            activeParameter: help.activeParameter,
          },
          dispose: () => undefined,
        };
      },
    });
    this.store(handle, d);
  }
  $unregister(handle: number): void {
    this.disposables.get(handle)?.dispose();
    this.disposables.delete(handle);
  }
  private toMonacoWorkspaceEdit(edit: WorkspaceEditDto): monaco.languages.WorkspaceEdit {
    const edits: monaco.languages.IWorkspaceTextEdit[] = [];
    for (const entry of edit.edits) {
      for (const e of entry.edits) {
        edits.push({
          resource: conv.dtoToUri(entry.resource),
          versionId: undefined,
          textEdit: { range: conv.toMonacoRange(e.range), text: e.text },
        });
      }
    }
    return { edits };
  }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export class MainThreadDiagnostics implements MainThreadDiagnosticsShape {
  private readonly ownerUris = new Map<string, Set<string>>();
  $changeMany(owner: string, entries: [UriComponents, DiagnosticDto[]][]): void {
    const uris = this.ownerUris.get(owner) ?? new Set<string>();
    for (const [uriDto, diags] of entries) {
      const uri = conv.dtoToUri(uriDto);
      const model = monaco.editor.getModel(uri);
      if (model) {
        monaco.editor.setModelMarkers(model, owner, diags.map(conv.toMonacoMarker));
      }
      uris.add(uri.toString());
    }
    this.ownerUris.set(owner, uris);
  }
  $clear(owner: string): void {
    const uris = this.ownerUris.get(owner);
    if (!uris) return;
    for (const uriStr of uris) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uriStr));
      if (model) monaco.editor.setModelMarkers(model, owner, []);
    }
    this.ownerUris.delete(owner);
  }
}

// ── Editors ───────────────────────────────────────────────────────────────────

export class MainThreadEditors implements MainThreadEditorsShape {
  async $applyWorkspaceEdit(edit: WorkspaceEditDto): Promise<boolean> {
    let ok = true;
    for (const entry of edit.edits) {
      const model = monaco.editor.getModel(conv.dtoToUri(entry.resource));
      if (!model) {
        ok = false;
        continue;
      }
      model.pushEditOperations(
        [],
        entry.edits.map((e) => ({ range: conv.toMonacoRange(e.range), text: e.text })),
        () => null,
      );
    }
    return ok;
  }
  $revealRange(uri: UriComponents, range: IRange): void {
    const model = monaco.editor.getModel(conv.dtoToUri(uri));
    if (!model) return;
    for (const editor of monaco.editor.getEditors()) {
      if (editor.getModel() === model) {
        editor.revealRangeInCenter(conv.toMonacoRange(range));
      }
    }
  }
}

// ── Workspace + filesystem + configuration ───────────────────────────────────

export class MainThreadWorkspace implements MainThreadWorkspaceShape {
  constructor(private readonly ctx: MainThreadContext) {}
  async $getConfiguration(section: string | undefined): Promise<Record<string, unknown>> {
    void section;
    return this.ctx.config;
  }
  async $updateConfiguration(section: string, value: unknown, _target: number): Promise<void> {
    this.ctx.config[section] = value;
    this.ctx.saveConfig(this.ctx.config);
  }
  async $findFiles(include: string, _exclude: string | undefined, maxResults: number): Promise<UriComponents[]> {
    try {
      const nodes = await invoke<{ path: string; is_dir?: boolean; isDir?: boolean }[]>("ide_list_files", {
        projectDir: this.ctx.projectDir,
        depth: 12,
      });
      const pattern = include.replace(/\*\*/g, "").replace(/\*/g, "");
      const matched = nodes
        .filter((n) => !(n.is_dir ?? n.isDir))
        .filter((n) => (pattern ? n.path.includes(pattern.replace(/^\.\//, "")) : true))
        .slice(0, maxResults);
      return matched.map((n) => conv.uriToDto(monaco.Uri.file(n.path)));
    } catch {
      return [];
    }
  }
  async $readFile(uri: UriComponents): Promise<string> {
    const res = await invoke<{ content: string }>("ide_read_file", { path: conv.dtoToUri(uri).fsPath });
    return res.content;
  }
  async $writeFile(uri: UriComponents, content: string): Promise<void> {
    await invoke<void>("ide_write_file", { path: conv.dtoToUri(uri).fsPath, content });
  }
  async $stat(uri: UriComponents): Promise<{ type: number; size: number } | null> {
    try {
      const res = await invoke<{ content: string }>("ide_read_file", { path: conv.dtoToUri(uri).fsPath });
      return { type: 1, size: res.content.length };
    } catch {
      return null;
    }
  }
  async $readDirectory(uri: UriComponents): Promise<[string, number][]> {
    try {
      const nodes = await invoke<{ name: string; path: string; is_dir?: boolean; isDir?: boolean }[]>("ide_list_files", {
        projectDir: conv.dtoToUri(uri).fsPath,
        depth: 1,
      });
      return nodes.map((n) => [n.name, (n.is_dir ?? n.isDir) ? 2 : 1]);
    } catch {
      return [];
    }
  }
  async $delete(uri: UriComponents, _recursive: boolean): Promise<void> {
    try {
      await invoke<void>("ide_file_action", { path: conv.dtoToUri(uri).fsPath, action: "delete" });
    } catch {
      /* best-effort */
    }
  }
}

// ── Documents (open/save triggers; sync is driven from extensionService) ──────

export class MainThreadDocuments {
  async $tryOpenDocument(_uri: UriComponents): Promise<void> {
    /* opening surfaces is handled by the IDE shell */
  }
  async $trySaveDocument(uri: UriComponents): Promise<boolean> {
    const model = monaco.editor.getModel(conv.dtoToUri(uri));
    if (!model) return false;
    try {
      await invoke<void>("ide_write_file", { path: conv.dtoToUri(uri).fsPath, content: model.getValue() });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Window UI (messages, status bar, output, quick input) ─────────────────────

export class MainThreadMessageService implements MainThreadMessageServiceShape {
  $showMessage(severity: number, message: string, options: { detail?: string }, items: string[]): Promise<string | undefined> {
    return extensionUiStore.pushMessage(severity, message, options?.detail, items);
  }
}

export class MainThreadStatusBar implements MainThreadStatusBarShape {
  $setEntry(entry: StatusBarEntryDto): void {
    extensionUiStore.setStatusBar(entry);
  }
  $dispose(id: string): void {
    extensionUiStore.removeStatusBar(id);
  }
}

export class MainThreadOutput implements MainThreadOutputShape {
  $register(channelId: string, label: string): void {
    extensionUiStore.registerOutput(channelId, label);
  }
  $append(channelId: string, value: string): void {
    extensionUiStore.appendOutput(channelId, value);
  }
  $clear(channelId: string): void {
    extensionUiStore.clearOutput(channelId);
  }
  $show(channelId: string): void {
    extensionUiStore.showOutput(channelId);
  }
}

export class MainThreadQuickOpen implements MainThreadQuickOpenShape {
  async $showQuickPick(_instanceId: number, items: QuickPickItemDto[], placeHolder: string | undefined, canPickMany: boolean): Promise<QuickPickItemDto | QuickPickItemDto[] | undefined> {
    const result = await extensionUiStore.showQuickPick({ items, placeHolder, canPickMany });
    return result as QuickPickItemDto | QuickPickItemDto[] | undefined;
  }
  $showInputBox(prompt: string | undefined, value: string | undefined, placeHolder: string | undefined, password: boolean): Promise<string | undefined> {
    return extensionUiStore.showInputBox({ prompt, value, placeHolder, password });
  }
}

// ── Tree views ────────────────────────────────────────────────────────────────

export class MainThreadTreeViews implements MainThreadTreeViewsShape {
  $registerView(viewId: string): void {
    extensionUiStore.registerTreeView(viewId);
  }
  $refresh(viewId: string, items: TreeItemDto[]): void {
    extensionUiStore.setTreeRoots(viewId, items);
  }
}

// ── Webviews ──────────────────────────────────────────────────────────────────

export class MainThreadWebviews implements MainThreadWebviewsShape {
  private readonly extHost;
  constructor(rpc: IRPCProtocol) {
    this.extHost = rpc.getProxy(ExtHostContext.ExtHostWebviews);
  }
  $createWebviewPanel(panel: WebviewPanelDto): void {
    extensionUiStore.setWebview({ handle: panel.handle, viewType: panel.viewType, title: panel.title, html: "" });
  }
  $setHtml(handle: string, html: string): void {
    extensionUiStore.setWebviewHtml(handle, html);
  }
  async $postMessage(handle: string, message: unknown): Promise<boolean> {
    // Forward to the iframe (handled by the WebviewHost React component bus).
    window.dispatchEvent(new CustomEvent("codez-webview-post", { detail: { handle, message } }));
    return true;
  }
  $dispose(handle: string): void {
    extensionUiStore.removeWebview(handle);
    this.extHost.$onDidDispose(handle);
  }
  /** Called by the WebviewHost component when the iframe posts to the extension. */
  postToExtension(handle: string, message: unknown): void {
    this.extHost.$onMessage(handle, message);
  }
}

// ── Terminal (reuse the IDE PTY) ──────────────────────────────────────────────

export class MainThreadTerminal implements MainThreadTerminalShape {
  constructor(private readonly ctx: MainThreadContext) {}
  async $createTerminal(id: string, _name: string): Promise<void> {
    try {
      await invoke<void>("ide_terminal_create", { terminalId: id, projectDir: this.ctx.projectDir });
    } catch {
      /* terminal surface may not be mounted */
    }
  }
  $sendText(id: string, text: string, addNewLine: boolean): void {
    void invoke("ide_terminal_write", { terminalId: id, data: addNewLine ? text + "\n" : text });
  }
  $show(_id: string): void {
    window.dispatchEvent(new CustomEvent("codez-show-terminal"));
  }
  $dispose(id: string): void {
    void invoke("ide_terminal_destroy", { terminalId: id });
  }
}

// ── SCM ───────────────────────────────────────────────────────────────────────

export class MainThreadScm implements MainThreadScmShape {
  $registerSourceControl(handle: number, id: string, label: string, rootUri: UriComponents | undefined): void {
    extensionUiStore.registerScm({ handle, id, label, rootPath: rootUri ? conv.dtoToUri(rootUri).fsPath : undefined, groups: [] });
  }
  $updateGroups(handle: number, groups: ScmGroupDto[]): void {
    extensionUiStore.updateScmGroups(handle, groups);
  }
  $unregisterSourceControl(handle: number): void {
    extensionUiStore.removeScm(handle);
  }
}

// ── Tasks (run via Tauri PTY) ─────────────────────────────────────────────────

export class MainThreadTask implements MainThreadTaskShape {
  constructor(private readonly ctx: MainThreadContext) {}
  $registerTaskProvider(_handle: number, _type: string): void {
    /* providers are pulled on demand */
  }
  $unregisterTaskProvider(_handle: number): void {
    /* no-op */
  }
  async $executeTask(task: TaskDto): Promise<void> {
    const id = `task-${task.id}-${Date.now()}`;
    const cmd = [task.command, ...(task.args ?? [])].filter(Boolean).join(" ");
    try {
      await invoke<void>("ide_terminal_create", { terminalId: id, projectDir: task.cwd ?? this.ctx.projectDir });
      await invoke<void>("ide_terminal_write", { terminalId: id, data: cmd + "\n" });
      window.dispatchEvent(new CustomEvent("codez-show-terminal"));
    } catch (err) {
      console.error("[ext] task execution failed", err);
    }
  }
}

// ── Debug ─────────────────────────────────────────────────────────────────────

export class MainThreadDebug implements MainThreadDebugShape {
  private readonly extHost;
  constructor(rpc: IRPCProtocol) {
    this.extHost = rpc.getProxy(ExtHostContext.ExtHostDebug);
  }
  $registerDebugConfigurationProvider(_type: string): void {
    /* tracked host-side */
  }
  async $startDebugging(config: DebugConfigurationDto): Promise<boolean> {
    const resolved = await this.extHost.$resolveDebugConfiguration(config.type, config);
    extensionUiStore.appendDebugOutput(`Starting debug session: ${JSON.stringify(resolved ?? config)}`);
    window.dispatchEvent(new CustomEvent("codez-debug-start", { detail: resolved ?? config }));
    return true;
  }
  $appendDebugOutput(category: string, output: string): void {
    extensionUiStore.appendDebugOutput(`[${category}] ${output}`);
  }
}

// ── Testing ───────────────────────────────────────────────────────────────────

export class MainThreadTesting implements MainThreadTestingShape {
  $registerTestController(controllerId: string, label: string): void {
    extensionUiStore.registerTestController(controllerId, label);
  }
  $publishTestItems(controllerId: string, items: TestItemDto[]): void {
    extensionUiStore.publishTestItems(controllerId, items);
  }
  $unregisterTestController(controllerId: string): void {
    extensionUiStore.removeTestController(controllerId);
  }
}

// ── Notebook ──────────────────────────────────────────────────────────────────

export class MainThreadNotebook implements MainThreadNotebookShape {
  private readonly registered = new Set<string>();
  $registerNotebookSerializer(viewType: string): void {
    this.registered.add(viewType);
  }
  $unregisterNotebookSerializer(viewType: string): void {
    this.registered.delete(viewType);
  }
  has(viewType: string): boolean {
    return this.registered.has(viewType);
  }
  viewTypes(): string[] {
    return [...this.registered];
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export interface MainThreadHandles {
  commands: MainThreadCommands;
  webviews: MainThreadWebviews;
  notebook: MainThreadNotebook;
  initData: InitDataDto;
}

export function registerMainThreads(ctx: MainThreadContext, initData: InitDataDto): MainThreadHandles {
  const { rpc } = ctx;
  const commands = new MainThreadCommands(rpc);
  const languageFeatures = new MainThreadLanguageFeatures(rpc);
  const diagnostics = new MainThreadDiagnostics();
  const editors = new MainThreadEditors();
  const workspace = new MainThreadWorkspace(ctx);
  const documents = new MainThreadDocuments();
  const messages = new MainThreadMessageService();
  const statusBar = new MainThreadStatusBar();
  const output = new MainThreadOutput();
  const quickOpen = new MainThreadQuickOpen();
  const treeViews = new MainThreadTreeViews();
  const webviews = new MainThreadWebviews(rpc);
  const terminal = new MainThreadTerminal(ctx);
  const scm = new MainThreadScm();
  const task = new MainThreadTask(ctx);
  const debug = new MainThreadDebug(rpc);
  const testing = new MainThreadTesting();
  const notebook = new MainThreadNotebook();

  rpc.set(MainContext.MainThreadCommands, commands);
  rpc.set(MainContext.MainThreadLanguageFeatures, languageFeatures);
  rpc.set(MainContext.MainThreadDiagnostics, diagnostics);
  rpc.set(MainContext.MainThreadEditors, editors);
  rpc.set(MainContext.MainThreadWorkspace, workspace);
  rpc.set(MainContext.MainThreadDocuments, documents);
  rpc.set(MainContext.MainThreadMessageService, messages);
  rpc.set(MainContext.MainThreadStatusBar, statusBar);
  rpc.set(MainContext.MainThreadOutput, output);
  rpc.set(MainContext.MainThreadQuickOpen, quickOpen);
  rpc.set(MainContext.MainThreadTreeViews, treeViews);
  rpc.set(MainContext.MainThreadWebviews, webviews);
  rpc.set(MainContext.MainThreadTerminal, terminal);
  rpc.set(MainContext.MainThreadScm, scm);
  rpc.set(MainContext.MainThreadTask, task);
  rpc.set(MainContext.MainThreadDebug, debug);
  rpc.set(MainContext.MainThreadTesting, testing);
  rpc.set(MainContext.MainThreadNotebook, notebook);

  return { commands, webviews, notebook, initData };
}
