// Builds the `vscode` module object handed to each extension's require('vscode').
// Mirrors VS Code's createApiFactoryAndRegisterActors: namespaces backed by the
// ExtHost* services, plus the concrete types and enums.

import { Services } from "./services";
import * as types from "./types-impl";
import { ExtensionDescriptionDto } from "../common/dto";
import { HOST_VSCODE_VERSION } from "../common/protocol";

export interface ExtensionContext {
  subscriptions: { dispose(): unknown }[];
  extensionPath: string;
  extensionUri: types.Uri;
  globalState: Memento;
  workspaceState: Memento;
  asAbsolutePath(relative: string): string;
  storageUri?: types.Uri;
  globalStorageUri: types.Uri;
  logUri: types.Uri;
  extensionMode: number;
  secrets: { get(k: string): Promise<string | undefined>; store(k: string, v: string): Promise<void>; delete(k: string): Promise<void> };
}

export class Memento {
  private data: Record<string, unknown> = {};
  get<T>(key: string, defaultValue?: T): T | undefined {
    return key in this.data ? (this.data[key] as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    return Promise.resolve();
  }
  keys(): string[] {
    return Object.keys(this.data);
  }
  setKeysForSync(): void {
    /* no-op */
  }
}

export function createApiFactory(services: Services) {
  const s = services;

  const commands = {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown, thisArg?: unknown) => s.commands.registerCommand(id, cb, thisArg),
    registerTextEditorCommand: (id: string, cb: (...a: unknown[]) => unknown, thisArg?: unknown) => s.commands.registerCommand(id, cb, thisArg),
    executeCommand: <T>(id: string, ...args: unknown[]) => s.commands.executeCommand<T>(id, ...args),
    getCommands: () => s.commands.getCommands(),
  };

  const window = {
    showInformationMessage: (m: string, ...r: unknown[]) => s.window.showInformationMessage(m, ...r),
    showWarningMessage: (m: string, ...r: unknown[]) => s.window.showWarningMessage(m, ...r),
    showErrorMessage: (m: string, ...r: unknown[]) => s.window.showErrorMessage(m, ...r),
    createStatusBarItem: (a?: types.StatusBarAlignment, p?: number) => s.window.createStatusBarItem(a, p),
    createOutputChannel: (name: string) => s.window.createOutputChannel(name),
    showQuickPick: (items: unknown, options?: { placeHolder?: string; canPickMany?: boolean }) => s.window.showQuickPick(items, options),
    showInputBox: (options?: { prompt?: string; value?: string; placeHolder?: string; password?: boolean }) => s.window.showInputBox(options),
    createTerminal: (o?: string | { name?: string }) => s.window.createTerminal(o),
    setStatusBarMessage: (t: string) => s.window.setStatusBarMessage(t),
    withProgress: <R>(o: unknown, t: (p: { report: (v: unknown) => void }, token: unknown) => Thenable<R>) => s.window.withProgress(o, t),
    registerTreeDataProvider: (viewId: string, provider: any) => s.treeViews.registerTreeDataProvider(viewId, provider),
    createTreeView: (viewId: string, options: any) => s.treeViews.createTreeView(viewId, options),
    createWebviewPanel: (viewType: string, title: string, showOptions: any, options?: any) => s.webviews.createWebviewPanel(viewType, title, showOptions, options),
    registerWebviewViewProvider: () => s.webviews.registerWebviewViewProvider(),
    get activeTextEditor() {
      const doc = s.documents.getActiveDocument();
      return doc ? { document: doc } : undefined;
    },
    get visibleTextEditors() {
      return s.documents.all().map((document) => ({ document }));
    },
    onDidChangeActiveTextEditor: (l: (e: unknown) => unknown) => s.documents.onDidChangeActiveEmitter.event((doc) => l(doc ? { document: doc } : undefined)),
    showTextDocument: () => Promise.resolve(undefined),
  };

  const workspace = {
    get workspaceFolders() {
      return s.workspace.workspaceFolders;
    },
    get rootPath() {
      return s.workspace.rootPath;
    },
    get name() {
      return s.workspace.workspaceFolders[0]?.name;
    },
    get textDocuments() {
      return s.documents.all();
    },
    getConfiguration: (section?: string) => s.workspace.getConfiguration(section),
    getWorkspaceFolder: (uri: types.Uri) => s.workspace.getWorkspaceFolder(uri),
    findFiles: (include: string, exclude?: string, maxResults?: number) => s.workspace.findFiles(include, exclude, maxResults),
    openTextDocument: (uriOrPath: types.Uri | string) => {
      const uri = typeof uriOrPath === "string" ? types.Uri.file(uriOrPath) : uriOrPath;
      const existing = s.documents.getDocument(uri.toJSON());
      return Promise.resolve(existing);
    },
    createFileSystemWatcher: () => s.workspace.registerFileSystemWatcher(),
    registerTaskProvider: (type: string, provider: any) => s.tasks.registerTaskProvider(type, provider),
    registerNotebookSerializer: (viewType: string, serializer: any) => s.notebook.registerNotebookSerializer(viewType, serializer),
    applyEdit: () => s.workspace.applyEdit(),
    onDidChangeConfiguration: s.workspace.onDidChangeConfigurationEmitter.event,
    onDidChangeWorkspaceFolders: s.workspace.onDidChangeWorkspaceFoldersEmitter.event,
    onDidOpenTextDocument: s.documents.onDidOpenEmitter.event,
    onDidCloseTextDocument: s.documents.onDidCloseEmitter.event,
    onDidChangeTextDocument: s.documents.onDidChangeEmitter.event,
    onDidSaveTextDocument: new types.EventEmitter<unknown>().event,
    fs: s.workspace.createFileSystem(),
  };

  const languages = {
    registerCompletionItemProvider: (sel: any, provider: any, ...triggers: string[]) => s.languageFeatures.registerCompletionItemProvider(sel, provider, triggers),
    registerHoverProvider: (sel: any, provider: any) => s.languageFeatures.registerHoverProvider(sel, provider),
    registerDefinitionProvider: (sel: any, provider: any) => s.languageFeatures.registerDefinitionProvider(sel, provider),
    registerReferenceProvider: (sel: any, provider: any) => s.languageFeatures.registerReferenceProvider(sel, provider),
    registerDocumentHighlightProvider: (sel: any, provider: any) => s.languageFeatures.registerDocumentHighlightProvider(sel, provider),
    registerDocumentSymbolProvider: (sel: any, provider: any) => s.languageFeatures.registerDocumentSymbolProvider(sel, provider),
    registerDocumentFormattingEditProvider: (sel: any, provider: any) => s.languageFeatures.registerDocumentFormattingEditProvider(sel, provider),
    registerCodeActionsProvider: (sel: any, provider: any) => s.languageFeatures.registerCodeActionsProvider(sel, provider),
    registerSignatureHelpProvider: (sel: any, provider: any, ...triggers: string[]) => s.languageFeatures.registerSignatureHelpProvider(sel, provider, triggers),
    createDiagnosticCollection: (name?: string) => s.workspace.createDiagnosticCollection(name),
    getLanguages: () => Promise.resolve<string[]>([]),
    setTextDocumentLanguage: () => Promise.resolve(undefined),
  };

  const scm = {
    createSourceControl: (id: string, label: string, rootUri?: types.Uri) => s.scm.createSourceControl(id, label, rootUri),
  };

  const tasks = {
    registerTaskProvider: (type: string, provider: any) => s.tasks.registerTaskProvider(type, provider),
    executeTask: (task: unknown) => s.tasks.executeTask(task),
    onDidStartTask: new types.EventEmitter<unknown>().event,
    onDidEndTask: new types.EventEmitter<unknown>().event,
  };

  const debug = {
    registerDebugConfigurationProvider: (type: string, provider: any) => s.debug.registerDebugConfigurationProvider(type, provider),
    registerDebugAdapterDescriptorFactory: () => s.debug.registerDebugAdapterDescriptorFactory(),
    startDebugging: (folder: unknown, config: any) => s.debug.startDebugging(folder, config),
    onDidStartDebugSession: s.debug.onDidStartDebugSessionEmitter.event,
    onDidTerminateDebugSession: s.debug.onDidTerminateDebugSessionEmitter.event,
    onDidReceiveDebugSessionCustomEvent: s.debug.onDidReceiveDebugSessionCustomEvent.event,
    get activeDebugSession() {
      return undefined;
    },
    breakpoints: [],
  };

  const tests = {
    createTestController: (id: string, label: string) => s.testing.createTestController(id, label),
  };

  const notebooks = {
    registerNotebookSerializer: (viewType: string, serializer: any) => s.notebook.registerNotebookSerializer(viewType, serializer),
  };

  const env = {
    appName: "AgentZ",
    appHost: "desktop",
    uriScheme: "agentz",
    language: "en",
    machineId: "agentz-machine",
    sessionId: `agentz-${Date.now()}`,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    clipboard: {
      readText: () => Promise.resolve(""),
      writeText: (_v: string) => Promise.resolve(),
    },
    openExternal: (_uri: types.Uri) => Promise.resolve(true),
  };

  return function api(extension: ExtensionDescriptionDto): Record<string, unknown> {
    void extension;
    return {
      // namespaces
      commands,
      window,
      workspace,
      languages,
      scm,
      tasks,
      debug,
      tests,
      notebooks,
      env,
      extensions: {
        getExtension: () => undefined,
        all: [],
        onDidChange: new types.EventEmitter<void>().event,
      },
      // version
      version: HOST_VSCODE_VERSION,
      // types
      Uri: types.Uri,
      Position: types.Position,
      Range: types.Range,
      Selection: types.Selection,
      Location: types.Location,
      Disposable: types.Disposable,
      EventEmitter: types.EventEmitter,
      CancellationTokenSource: types.CancellationTokenSource,
      MarkdownString: types.MarkdownString,
      CompletionItem: types.CompletionItem,
      CompletionList: types.CompletionList,
      SnippetString: types.SnippetString,
      Hover: types.Hover,
      Diagnostic: types.Diagnostic,
      DiagnosticRelatedInformation: types.DiagnosticRelatedInformation,
      TextEdit: types.TextEdit,
      WorkspaceEdit: types.WorkspaceEdit,
      CodeAction: types.CodeAction,
      CodeActionKind: types.CodeActionKind,
      DocumentSymbol: types.DocumentSymbol,
      SignatureHelp: types.SignatureHelp,
      SignatureInformation: types.SignatureInformation,
      ParameterInformation: types.ParameterInformation,
      ThemeIcon: types.ThemeIcon,
      ThemeColor: types.ThemeColor,
      TreeItem: types.TreeItem,
      RelativePattern: types.RelativePattern,
      // enums
      CompletionItemKind: types.CompletionItemKind,
      DiagnosticSeverity: types.DiagnosticSeverity,
      SymbolKind: types.SymbolKind,
      StatusBarAlignment: types.StatusBarAlignment,
      ConfigurationTarget: types.ConfigurationTarget,
      ViewColumn: types.ViewColumn,
      TreeItemCollapsibleState: types.TreeItemCollapsibleState,
      FileType: types.FileType,
      EndOfLine: types.EndOfLine,
      TextEditorRevealType: types.TextEditorRevealType,
      ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    };
  };
}
