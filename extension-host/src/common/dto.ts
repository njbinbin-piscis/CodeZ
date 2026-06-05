// Serializable data-transfer objects crossing the RPC boundary. These are the
// "wire" shapes; rich vscode.* types are converted to/from these on each side.

export interface UriComponents {
  scheme: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
}

/** vscode positions are 0-indexed (line + character). */
export interface IPosition {
  line: number;
  character: number;
}

export interface IRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface MarkdownStringDto {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
}

export interface CompletionItemDto {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkdownStringDto;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextIsSnippet?: boolean;
  range?: IRange;
  commitCharacters?: string[];
  preselect?: boolean;
}

export interface CompletionListDto {
  isIncomplete?: boolean;
  items: CompletionItemDto[];
}

export interface HoverDto {
  contents: (string | MarkdownStringDto)[];
  range?: IRange;
}

export interface LocationDto {
  uri: UriComponents;
  range: IRange;
}

export interface DocumentHighlightDto {
  range: IRange;
  kind?: number;
}

export interface TextEditDto {
  range: IRange;
  text: string;
}

export interface DiagnosticRelatedDto {
  location: LocationDto;
  message: string;
}

export interface DiagnosticDto {
  range: IRange;
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  relatedInformation?: DiagnosticRelatedDto[];
}

export interface DocumentSymbolDto {
  name: string;
  detail?: string;
  kind: number;
  range: IRange;
  selectionRange: IRange;
  children?: DocumentSymbolDto[];
}

export interface CommandDto {
  id: string;
  title: string;
  arguments?: unknown[];
}

export interface CodeActionDto {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: DiagnosticDto[];
  edit?: WorkspaceEditDto;
  command?: CommandDto;
}

export interface WorkspaceEditEntryDto {
  resource: UriComponents;
  edits: TextEditDto[];
}

export interface WorkspaceEditDto {
  edits: WorkspaceEditEntryDto[];
}

export interface SignatureHelpDto {
  signatures: {
    label: string;
    documentation?: string | MarkdownStringDto;
    parameters: { label: string; documentation?: string }[];
  }[];
  activeSignature: number;
  activeParameter: number;
}

export interface DocumentModelDto {
  uri: UriComponents;
  languageId: string;
  versionId: number;
  lines: string[];
  eol: string;
}

export interface ModelChangedEventDto {
  uri: UriComponents;
  versionId: number;
  changes: { range: IRange; text: string }[];
  eol: string;
}

// ── Contributions / manifest ────────────────────────────────────────────────

export interface ExtensionDescriptionDto {
  id: string;
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  main?: string;
  extensionPath: string;
  activationEvents: string[];
  contributes?: Record<string, unknown>;
  engines?: Record<string, string>;
  enabledApiProposals?: string[];
}

// ── UI DTOs ─────────────────────────────────────────────────────────────────

export interface StatusBarEntryDto {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  alignment: number; // 1 left, 2 right
  priority?: number;
  color?: string;
  backgroundColor?: string;
}

export interface MessageOptionsDto {
  modal?: boolean;
  detail?: string;
}

export interface TreeItemDto {
  handle: string;
  parentHandle?: string;
  label?: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  collapsibleState: number; // 0 none, 1 collapsed, 2 expanded
  contextValue?: string;
  command?: CommandDto;
  resourceUri?: UriComponents;
}

export interface QuickPickItemDto {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

export interface WebviewOptionsDto {
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
}

export interface WebviewPanelDto {
  handle: string;
  viewType: string;
  title: string;
  viewColumn?: number;
  options: WebviewOptionsDto;
}

// ── SCM ─────────────────────────────────────────────────────────────────────

export interface ScmResourceDto {
  handle: number;
  resourceUri: UriComponents;
  tooltip?: string;
  decorationIcon?: string;
  strikeThrough?: boolean;
  faded?: boolean;
}

export interface ScmGroupDto {
  handle: number;
  id: string;
  label: string;
  hideWhenEmpty?: boolean;
  resources: ScmResourceDto[];
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskDto {
  id: string;
  name: string;
  source: string;
  type: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

// ── Debug ───────────────────────────────────────────────────────────────────

export interface DebugConfigurationDto {
  type: string;
  name: string;
  request: string;
  [key: string]: unknown;
}

// ── Testing ─────────────────────────────────────────────────────────────────

export interface TestItemDto {
  id: string;
  label: string;
  uri?: UriComponents;
  range?: IRange;
  parentId?: string;
  children?: TestItemDto[];
}

// ── Notebook ────────────────────────────────────────────────────────────────

export interface NotebookCellDto {
  handle: number;
  kind: number; // 1 markup, 2 code
  language: string;
  source: string;
}

export interface NotebookDocumentDto {
  uri: UriComponents;
  notebookType: string;
  cells: NotebookCellDto[];
}
