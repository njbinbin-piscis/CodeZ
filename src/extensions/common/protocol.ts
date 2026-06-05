// The single authoritative cross-process contract (mirrors VS Code's
// extHost.protocol.ts). MainThread* shapes are implemented on the renderer and
// called by the host; ExtHost* shapes are implemented in the host and called by
// the renderer. All RPC methods are `$`-prefixed.

import { createProxyIdentifier, ProxyIdentifier } from "./proxyIdentifier";
import * as dto from "./dto";

// ── MainThread shapes (implemented on renderer) ─────────────────────────────

export interface MainThreadCommandsShape {
  $registerCommand(id: string): void;
  $unregisterCommand(id: string): void;
  $executeCommand(id: string, args: unknown[]): Promise<unknown>;
}

export interface MainThreadMessageServiceShape {
  $showMessage(
    severity: number,
    message: string,
    options: dto.MessageOptionsDto,
    items: string[],
  ): Promise<string | undefined>;
}

export interface MainThreadStatusBarShape {
  $setEntry(entry: dto.StatusBarEntryDto): void;
  $dispose(id: string): void;
}

export interface MainThreadOutputShape {
  $register(channelId: string, label: string): void;
  $append(channelId: string, value: string): void;
  $clear(channelId: string): void;
  $show(channelId: string, preserveFocus: boolean): void;
}

export interface MainThreadQuickOpenShape {
  $showQuickPick(
    instanceId: number,
    items: dto.QuickPickItemDto[],
    placeHolder: string | undefined,
    canPickMany: boolean,
  ): Promise<dto.QuickPickItemDto | dto.QuickPickItemDto[] | undefined>;
  $showInputBox(
    prompt: string | undefined,
    value: string | undefined,
    placeHolder: string | undefined,
    password: boolean,
  ): Promise<string | undefined>;
}

export interface MainThreadDocumentsShape {
  $tryOpenDocument(uri: dto.UriComponents): Promise<void>;
  $trySaveDocument(uri: dto.UriComponents): Promise<boolean>;
}

export interface MainThreadEditorsShape {
  $applyWorkspaceEdit(edit: dto.WorkspaceEditDto): Promise<boolean>;
  $revealRange(uri: dto.UriComponents, range: dto.IRange): void;
}

export interface MainThreadDiagnosticsShape {
  $changeMany(owner: string, entries: [dto.UriComponents, dto.DiagnosticDto[]][]): void;
  $clear(owner: string): void;
}

export interface MainThreadLanguageFeaturesShape {
  $registerCompletionSupport(handle: number, selector: string[], triggerCharacters: string[]): void;
  $registerHoverProvider(handle: number, selector: string[]): void;
  $registerDefinitionProvider(handle: number, selector: string[]): void;
  $registerReferenceProvider(handle: number, selector: string[]): void;
  $registerDocumentHighlightProvider(handle: number, selector: string[]): void;
  $registerDocumentSymbolProvider(handle: number, selector: string[]): void;
  $registerFormattingProvider(handle: number, selector: string[]): void;
  $registerCodeActionProvider(handle: number, selector: string[]): void;
  $registerSignatureHelpProvider(handle: number, selector: string[], triggerCharacters: string[]): void;
  $unregister(handle: number): void;
}

export interface MainThreadWorkspaceShape {
  $getConfiguration(section: string | undefined): Promise<Record<string, unknown>>;
  $updateConfiguration(section: string, value: unknown, target: number): Promise<void>;
  $findFiles(include: string, exclude: string | undefined, maxResults: number): Promise<dto.UriComponents[]>;
  $readFile(uri: dto.UriComponents): Promise<string>;
  $writeFile(uri: dto.UriComponents, content: string): Promise<void>;
  $stat(uri: dto.UriComponents): Promise<{ type: number; size: number } | null>;
  $readDirectory(uri: dto.UriComponents): Promise<[string, number][]>;
  $delete(uri: dto.UriComponents, recursive: boolean): Promise<void>;
}

export interface MainThreadTreeViewsShape {
  $registerView(viewId: string): void;
  $refresh(viewId: string, items: dto.TreeItemDto[]): void;
}

export interface MainThreadWebviewsShape {
  $createWebviewPanel(panel: dto.WebviewPanelDto): void;
  $setHtml(handle: string, html: string): void;
  $postMessage(handle: string, message: unknown): Promise<boolean>;
  $dispose(handle: string): void;
}

export interface MainThreadTerminalShape {
  $createTerminal(id: string, name: string): Promise<void>;
  $sendText(id: string, text: string, addNewLine: boolean): void;
  $show(id: string): void;
  $dispose(id: string): void;
}

export interface MainThreadScmShape {
  $registerSourceControl(handle: number, id: string, label: string, rootUri: dto.UriComponents | undefined): void;
  $updateGroups(handle: number, groups: dto.ScmGroupDto[]): void;
  $unregisterSourceControl(handle: number): void;
}

export interface MainThreadTaskShape {
  $registerTaskProvider(handle: number, type: string): void;
  $unregisterTaskProvider(handle: number): void;
  $executeTask(task: dto.TaskDto): Promise<void>;
}

export interface MainThreadDebugShape {
  $registerDebugConfigurationProvider(type: string): void;
  $startDebugging(config: dto.DebugConfigurationDto): Promise<boolean>;
  $appendDebugOutput(category: string, output: string): void;
}

export interface MainThreadTestingShape {
  $registerTestController(controllerId: string, label: string): void;
  $publishTestItems(controllerId: string, items: dto.TestItemDto[]): void;
  $unregisterTestController(controllerId: string): void;
}

export interface MainThreadNotebookShape {
  $registerNotebookSerializer(viewType: string): void;
  $unregisterNotebookSerializer(viewType: string): void;
}

// ── ExtHost shapes (implemented in the host) ────────────────────────────────

export interface ExtHostCommandsShape {
  $executeContributedCommand(id: string, args: unknown[]): Promise<unknown>;
}

export interface ExtHostLanguageFeaturesShape {
  $provideCompletionItems(handle: number, uri: dto.UriComponents, position: dto.IPosition, triggerCharacter?: string): Promise<dto.CompletionListDto | undefined>;
  $provideHover(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.HoverDto | undefined>;
  $provideDefinition(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.LocationDto[] | undefined>;
  $provideReferences(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.LocationDto[] | undefined>;
  $provideDocumentHighlights(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.DocumentHighlightDto[] | undefined>;
  $provideDocumentSymbols(handle: number, uri: dto.UriComponents): Promise<dto.DocumentSymbolDto[] | undefined>;
  $provideDocumentFormattingEdits(handle: number, uri: dto.UriComponents): Promise<dto.TextEditDto[] | undefined>;
  $provideCodeActions(handle: number, uri: dto.UriComponents, range: dto.IRange): Promise<dto.CodeActionDto[] | undefined>;
  $provideSignatureHelp(handle: number, uri: dto.UriComponents, position: dto.IPosition): Promise<dto.SignatureHelpDto | undefined>;
}

export interface ExtHostDocumentsShape {
  $acceptModelChanged(event: dto.ModelChangedEventDto): void;
  $acceptModelOpened(model: dto.DocumentModelDto): void;
  $acceptModelClosed(uri: dto.UriComponents): void;
  $acceptActiveEditorChanged(uri: dto.UriComponents | undefined): void;
}

export interface ExtHostConfigurationShape {
  $acceptConfigurationChanged(data: Record<string, unknown>): void;
}

export interface ExtHostWorkspaceShape {
  $acceptWorkspaceFoldersChanged(folders: dto.UriComponents[]): void;
}

export interface ExtHostTreeViewsShape {
  $getChildren(viewId: string, parentHandle?: string): Promise<dto.TreeItemDto[]>;
  $resolveCommand(viewId: string, handle: string): Promise<dto.CommandDto | undefined>;
}

export interface ExtHostWebviewsShape {
  $onMessage(handle: string, message: unknown): void;
  $onDidDispose(handle: string): void;
}

export interface ExtHostTaskShape {
  $provideTasks(handle: number): Promise<dto.TaskDto[]>;
}

export interface ExtHostDebugShape {
  $resolveDebugConfiguration(type: string, config: dto.DebugConfigurationDto): Promise<dto.DebugConfigurationDto | undefined>;
}

export interface ExtHostTestingShape {
  $runTests(controllerId: string, testIds: string[]): Promise<void>;
}

export interface ExtHostNotebookShape {
  $deserializeNotebook(viewType: string, content: string): Promise<dto.NotebookDocumentDto>;
  $serializeNotebook(viewType: string, doc: dto.NotebookDocumentDto): Promise<string>;
}

export interface InitDataDto {
  workspaceFolders: dto.UriComponents[];
  configuration: Record<string, unknown>;
  extensions: dto.ExtensionDescriptionDto[];
  extensionsDir?: string;
}

/** The VS Code API version this host implements; used for engines.vscode checks. */
export const HOST_VSCODE_VERSION = "1.96.0";

/** Per-extension compatibility verdict produced during initialization. */
export interface ExtensionCompatDto {
  id: string;
  displayName?: string;
  version: string;
  enginesVscode?: string;
  compatible: boolean;
  reason?: string;
  unsupportedProposals?: string[];
  activated: boolean;
}

export interface CompatReportDto {
  hostVersion: string;
  extensions: ExtensionCompatDto[];
}

export interface ExtHostExtensionServiceShape {
  $initialize(data: InitDataDto): Promise<CompatReportDto>;
  $activateByEvent(event: string): Promise<void>;
  $activateExtension(id: string): Promise<void>;
}

// ── Context registries ──────────────────────────────────────────────────────

export const MainContext = {
  MainThreadCommands: createProxyIdentifier<MainThreadCommandsShape>("MainThreadCommands"),
  MainThreadMessageService: createProxyIdentifier<MainThreadMessageServiceShape>("MainThreadMessageService"),
  MainThreadStatusBar: createProxyIdentifier<MainThreadStatusBarShape>("MainThreadStatusBar"),
  MainThreadOutput: createProxyIdentifier<MainThreadOutputShape>("MainThreadOutput"),
  MainThreadQuickOpen: createProxyIdentifier<MainThreadQuickOpenShape>("MainThreadQuickOpen"),
  MainThreadDocuments: createProxyIdentifier<MainThreadDocumentsShape>("MainThreadDocuments"),
  MainThreadEditors: createProxyIdentifier<MainThreadEditorsShape>("MainThreadEditors"),
  MainThreadDiagnostics: createProxyIdentifier<MainThreadDiagnosticsShape>("MainThreadDiagnostics"),
  MainThreadLanguageFeatures: createProxyIdentifier<MainThreadLanguageFeaturesShape>("MainThreadLanguageFeatures"),
  MainThreadWorkspace: createProxyIdentifier<MainThreadWorkspaceShape>("MainThreadWorkspace"),
  MainThreadTreeViews: createProxyIdentifier<MainThreadTreeViewsShape>("MainThreadTreeViews"),
  MainThreadWebviews: createProxyIdentifier<MainThreadWebviewsShape>("MainThreadWebviews"),
  MainThreadTerminal: createProxyIdentifier<MainThreadTerminalShape>("MainThreadTerminal"),
  MainThreadScm: createProxyIdentifier<MainThreadScmShape>("MainThreadScm"),
  MainThreadTask: createProxyIdentifier<MainThreadTaskShape>("MainThreadTask"),
  MainThreadDebug: createProxyIdentifier<MainThreadDebugShape>("MainThreadDebug"),
  MainThreadTesting: createProxyIdentifier<MainThreadTestingShape>("MainThreadTesting"),
  MainThreadNotebook: createProxyIdentifier<MainThreadNotebookShape>("MainThreadNotebook"),
};

export const ExtHostContext = {
  ExtHostCommands: createProxyIdentifier<ExtHostCommandsShape>("ExtHostCommands"),
  ExtHostLanguageFeatures: createProxyIdentifier<ExtHostLanguageFeaturesShape>("ExtHostLanguageFeatures"),
  ExtHostDocuments: createProxyIdentifier<ExtHostDocumentsShape>("ExtHostDocuments"),
  ExtHostConfiguration: createProxyIdentifier<ExtHostConfigurationShape>("ExtHostConfiguration"),
  ExtHostWorkspace: createProxyIdentifier<ExtHostWorkspaceShape>("ExtHostWorkspace"),
  ExtHostTreeViews: createProxyIdentifier<ExtHostTreeViewsShape>("ExtHostTreeViews"),
  ExtHostWebviews: createProxyIdentifier<ExtHostWebviewsShape>("ExtHostWebviews"),
  ExtHostTask: createProxyIdentifier<ExtHostTaskShape>("ExtHostTask"),
  ExtHostDebug: createProxyIdentifier<ExtHostDebugShape>("ExtHostDebug"),
  ExtHostTesting: createProxyIdentifier<ExtHostTestingShape>("ExtHostTesting"),
  ExtHostNotebook: createProxyIdentifier<ExtHostNotebookShape>("ExtHostNotebook"),
  ExtHostExtensionService: createProxyIdentifier<ExtHostExtensionServiceShape>("ExtHostExtensionService"),
};

export type ProxyId = ProxyIdentifier<unknown>;
