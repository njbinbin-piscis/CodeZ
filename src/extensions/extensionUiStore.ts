// Observable store backing all extension-contributed UI. MainThread services
// mutate it; React components subscribe via useSyncExternalStore.

import type {
  ScmGroupDto,
  StatusBarEntryDto,
  TestItemDto,
  TreeItemDto,
} from "./common/dto";

export interface MessageToast {
  id: number;
  severity: number; // 0 error, 1 warning, 2 info
  message: string;
  detail?: string;
  items: string[];
  resolve: (value: string | undefined) => void;
}

export interface QuickPickRequest {
  id: number;
  items: { label: string; description?: string; detail?: string; picked?: boolean }[];
  placeHolder?: string;
  canPickMany: boolean;
  resolve: (value: unknown) => void;
}

export interface InputBoxRequest {
  id: number;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password: boolean;
  resolve: (value: string | undefined) => void;
}

export interface OutputChannelState {
  id: string;
  label: string;
  content: string;
}

export interface TreeViewState {
  viewId: string;
  roots: TreeItemDto[];
  version: number;
}

export interface WebviewState {
  handle: string;
  viewType: string;
  title: string;
  html: string;
}

export interface ScmProviderState {
  handle: number;
  id: string;
  label: string;
  rootPath?: string;
  groups: ScmGroupDto[];
}

export interface TestControllerState {
  controllerId: string;
  label: string;
  items: TestItemDto[];
}

export interface ExtensionUiSnapshot {
  statusBar: StatusBarEntryDto[];
  outputChannels: OutputChannelState[];
  activeOutput: string | null;
  treeViews: TreeViewState[];
  webviews: WebviewState[];
  messages: MessageToast[];
  quickPick: QuickPickRequest | null;
  inputBox: InputBoxRequest | null;
  scm: ScmProviderState[];
  tests: TestControllerState[];
  debugOutput: string[];
  hostLog: string[];
  running: boolean;
}

const EMPTY: ExtensionUiSnapshot = {
  statusBar: [],
  outputChannels: [],
  activeOutput: null,
  treeViews: [],
  webviews: [],
  messages: [],
  quickPick: null,
  inputBox: null,
  scm: [],
  tests: [],
  debugOutput: [],
  hostLog: [],
  running: false,
};

class ExtensionUiStore {
  private listeners = new Set<() => void>();
  private statusBar = new Map<string, StatusBarEntryDto>();
  private outputChannels = new Map<string, OutputChannelState>();
  private activeOutput: string | null = null;
  private treeViews = new Map<string, TreeViewState>();
  private webviews = new Map<string, WebviewState>();
  private messages: MessageToast[] = [];
  private quickPick: QuickPickRequest | null = null;
  private inputBox: InputBoxRequest | null = null;
  private scm = new Map<number, ScmProviderState>();
  private tests = new Map<string, TestControllerState>();
  private debugOutput: string[] = [];
  private hostLog: string[] = [];
  private running = false;
  private seq = 1;
  private snapshot: ExtensionUiSnapshot = EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ExtensionUiSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = {
      statusBar: [...this.statusBar.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
      outputChannels: [...this.outputChannels.values()],
      activeOutput: this.activeOutput,
      treeViews: [...this.treeViews.values()],
      webviews: [...this.webviews.values()],
      messages: [...this.messages],
      quickPick: this.quickPick,
      inputBox: this.inputBox,
      scm: [...this.scm.values()],
      tests: [...this.tests.values()],
      debugOutput: [...this.debugOutput],
      hostLog: [...this.hostLog],
      running: this.running,
    };
    for (const l of this.listeners) l();
  }

  nextId(): number {
    return this.seq++;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.emit();
  }

  appendHostLog(line: string): void {
    this.hostLog.push(line);
    if (this.hostLog.length > 500) this.hostLog.shift();
    this.emit();
  }

  // ── status bar ──
  setStatusBar(entry: StatusBarEntryDto): void {
    this.statusBar.set(entry.id, entry);
    this.emit();
  }
  removeStatusBar(id: string): void {
    if (this.statusBar.delete(id)) this.emit();
  }

  // ── output ──
  registerOutput(id: string, label: string): void {
    if (!this.outputChannels.has(id)) {
      this.outputChannels.set(id, { id, label, content: "" });
      if (!this.activeOutput) this.activeOutput = id;
      this.emit();
    }
  }
  appendOutput(id: string, value: string): void {
    const ch = this.outputChannels.get(id);
    if (ch) {
      ch.content += value;
      this.emit();
    }
  }
  clearOutput(id: string): void {
    const ch = this.outputChannels.get(id);
    if (ch) {
      ch.content = "";
      this.emit();
    }
  }
  showOutput(id: string): void {
    this.activeOutput = id;
    this.emit();
  }

  // ── messages ──
  pushMessage(severity: number, message: string, detail: string | undefined, items: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const id = this.nextId();
      const toast: MessageToast = {
        id,
        severity,
        message,
        detail,
        items,
        resolve: (value) => {
          this.messages = this.messages.filter((m) => m.id !== id);
          this.emit();
          resolve(value);
        },
      };
      this.messages.push(toast);
      this.emit();
      // Auto-dismiss informational toasts with no actions.
      if (severity === 2 && items.length === 0) {
        setTimeout(() => toast.resolve(undefined), 5000);
      }
    });
  }

  // ── quick input ──
  showQuickPick(req: Omit<QuickPickRequest, "id" | "resolve">): Promise<unknown> {
    return new Promise((resolve) => {
      this.quickPick = {
        ...req,
        id: this.nextId(),
        resolve: (value) => {
          this.quickPick = null;
          this.emit();
          resolve(value);
        },
      };
      this.emit();
    });
  }
  showInputBox(req: Omit<InputBoxRequest, "id" | "resolve">): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.inputBox = {
        ...req,
        id: this.nextId(),
        resolve: (value) => {
          this.inputBox = null;
          this.emit();
          resolve(value);
        },
      };
      this.emit();
    });
  }

  // ── tree views ──
  registerTreeView(viewId: string): void {
    if (!this.treeViews.has(viewId)) {
      this.treeViews.set(viewId, { viewId, roots: [], version: 0 });
      this.emit();
    }
  }
  setTreeRoots(viewId: string, roots: TreeItemDto[]): void {
    const view = this.treeViews.get(viewId) ?? { viewId, roots: [], version: 0 };
    view.roots = roots;
    view.version++;
    this.treeViews.set(viewId, view);
    this.emit();
  }

  // ── webviews ──
  setWebview(state: WebviewState): void {
    this.webviews.set(state.handle, state);
    this.emit();
  }
  setWebviewHtml(handle: string, html: string): void {
    const wv = this.webviews.get(handle);
    if (wv) {
      wv.html = html;
      this.emit();
    }
  }
  removeWebview(handle: string): void {
    if (this.webviews.delete(handle)) this.emit();
  }

  // ── scm ──
  registerScm(state: ScmProviderState): void {
    this.scm.set(state.handle, state);
    this.emit();
  }
  updateScmGroups(handle: number, groups: ScmGroupDto[]): void {
    const p = this.scm.get(handle);
    if (p) {
      p.groups = groups;
      this.emit();
    }
  }
  removeScm(handle: number): void {
    if (this.scm.delete(handle)) this.emit();
  }

  // ── tests ──
  registerTestController(controllerId: string, label: string): void {
    this.tests.set(controllerId, { controllerId, label, items: [] });
    this.emit();
  }
  publishTestItems(controllerId: string, items: TestItemDto[]): void {
    const c = this.tests.get(controllerId);
    if (c) {
      c.items = items;
      this.emit();
    }
  }
  removeTestController(controllerId: string): void {
    if (this.tests.delete(controllerId)) this.emit();
  }

  // ── debug ──
  appendDebugOutput(line: string): void {
    this.debugOutput.push(line);
    if (this.debugOutput.length > 1000) this.debugOutput.shift();
    this.emit();
  }

  reset(): void {
    this.statusBar.clear();
    this.outputChannels.clear();
    this.activeOutput = null;
    this.treeViews.clear();
    this.webviews.clear();
    this.messages = [];
    this.quickPick = null;
    this.inputBox = null;
    this.scm.clear();
    this.tests.clear();
    this.debugOutput = [];
    this.emit();
  }
}

export const extensionUiStore = new ExtensionUiStore();
