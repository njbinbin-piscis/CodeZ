// Orchestrates the renderer side of the extension ecosystem: launches the host
// sidecar, wires the RPC protocol + MainThread actors, syncs Monaco documents
// into the host, and initializes the extension registry.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";

import { RPCProtocol } from "./common/rpcProtocol";
import { ExtHostContext, type InitDataDto } from "./common/protocol";
import type { ExtensionDescriptionDto, ModelChangedEventDto } from "./common/dto";
import { TauriExtHostTransport } from "./transport";
import { registerMainThreads, type MainThreadContext, type MainThreadHandles } from "./mainThreads";
import * as conv from "./typeConverters";
import { extensionUiStore } from "./extensionUiStore";
import { compatStore } from "./compatStore";
import { composerDbg } from "../utils/composerDebug";

interface InstalledExtensionRaw {
  id: string;
  name: string;
  publisher: string;
  version: string;
  display_name: string;
  description: string;
  main: string | null;
  extension_path: string;
  activation_events: string[];
  contributes: unknown;
  enabled: boolean;
}

const CONFIG_KEY = "agentz.ext.config";

function loadConfig(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

export class ExtensionService {
  private rpc: RPCProtocol | undefined;
  private transport: TauriExtHostTransport | undefined;
  private handles: MainThreadHandles | undefined;
  private disposables: monaco.IDisposable[] = [];
  private started = false;
  /** Serializes start/stop so React effect cleanups cannot race startup. */
  private opChain: Promise<void> = Promise.resolve();
  /** Only the focused editor model is synced to the extension host (RPC reduction). */
  private activeModelKey: string | null = null;
  projectDir = "";

  setActiveEditorModel(model: monaco.editor.ITextModel | null): void {
    this.activeModelKey = model?.uri.toString() ?? null;
    if (model && this.rpc) {
      this.ensureModelSynced(model);
    }
  }

  private shouldSyncModel(model: monaco.editor.ITextModel): boolean {
    if (model.uri.scheme === "inmemory") return false;
    if (!this.activeModelKey) return true;
    return model.uri.toString() === this.activeModelKey;
  }

  get isRunning(): boolean {
    return this.started;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Boot the extension host for a project and activate startup extensions. */
  async start(projectDir: string, opts?: { force?: boolean }): Promise<void> {
    return this.runExclusive(async () => {
      // Skip redundant restart — a stop+wireDocumentSync during an active chat
      // turn was freezing the renderer (black screen).
      if (
        !opts?.force &&
        this.started &&
        this.projectDir === projectDir &&
        this.rpc
      ) {
        composerDbg("extensionService.start skipped (already running)", { projectDir });
        return;
      }
      composerDbg("extensionService.start", {
        projectDir,
        alreadyStarted: this.started,
        currentDir: this.projectDir,
      });
      // Keep the latest project dir visible to UI actions (manual restart, etc.)
      // even while a prior stop is still draining on the op chain.
      this.projectDir = projectDir;
      await this.stopInternal();

    const [extensionsDir, installed] = await Promise.all([
      invoke<string>("vsix_extensions_dir").catch(() => ""),
      invoke<InstalledExtensionRaw[]>("vsix_list").catch(() => [] as InstalledExtensionRaw[]),
    ]);

    const extensions: ExtensionDescriptionDto[] = installed
      .filter((e) => e.enabled)
      .map((e) => ({
        id: e.id,
        name: e.name,
        publisher: e.publisher,
        version: e.version,
        displayName: e.display_name,
        main: e.main ?? undefined,
        extensionPath: e.extension_path,
        activationEvents: e.activation_events,
        // Host reads package.json from extensionPath; omit huge contributes blobs.
      }));

    if (extensions.length === 0) {
      extensionUiStore.setRunning(false);
      extensionUiStore.setHostError("no_enabled_extensions");
      return;
    }

    this.transport = new TauriExtHostTransport((line) => extensionUiStore.appendHostLog(line));
    await this.transport.connect();

    // Register the ready waiter *before* spawning — the host can log "ready"
    // within milliseconds and we must not miss that line.
    const readyWait = this.transport.waitForReady();
    await invoke("ext_host_start", { projectDir });
    await readyWait;
    // Process is up — reflect that immediately so manual start / status bar
    // don't look like a no-op while $initialize is still in flight.
    extensionUiStore.setRunning(true);

    this.rpc = new RPCProtocol(this.transport);
    this.transport.onConnectionLost((reason) => {
      this.rpc?.failAllPending(reason);
      extensionUiStore.setRunning(false);
      extensionUiStore.setHostError(reason);
    });
    compatStore.reset();
    this.rpc.onMissingApi((nid, method) => compatStore.recordMissing(nid, method));

    const config = loadConfig();
    const ctx: MainThreadContext = { rpc: this.rpc, projectDir, config, saveConfig };

    const initData: InitDataDto = {
      workspaceFolders: [conv.uriToDto(monaco.Uri.file(projectDir))],
      configuration: config,
      extensions,
      extensionsDir,
    };
    this.handles = registerMainThreads(ctx, initData);

    const extHost = this.rpc.getProxy(ExtHostContext.ExtHostExtensionService);
    try {
      const report = await extHost.$initialize(initData);
      compatStore.setReport(report);
      extensionUiStore.setHostError(null);
    } catch (e) {
      extensionUiStore.setHostError(String(e));
      throw e;
    }

    // Sync open editors only after the handshake — flooding RPC before
    // $initialize was causing 45s timeouts when many models were open.
    this.wireDocumentSync();

    this.started = true;
    });
  }

  private modelSyncs = new Map<
    string,
    {
      changeSub: monaco.IDisposable;
      flushTimer: ReturnType<typeof setTimeout> | undefined;
      pendingChanges: ModelChangedEventDto["changes"];
    }
  >();

  private ensureModelSynced(model: monaco.editor.ITextModel): void {
    if (!this.rpc || !this.shouldSyncModel(model)) return;
    const key = model.uri.toString();
    if (this.modelSyncs.has(key)) return;

    const extHostDocs = this.rpc.getProxy(ExtHostContext.ExtHostDocuments);
    const MAX_SYNC_LINES = 2000;
    const MAX_SYNC_CHARS = 512_000;
    const rpc = this.rpc;
    window.setTimeout(() => {
      if (this.rpc !== rpc) return;
      const lines = model.getLinesContent();
      let syncLines = lines;
      const totalChars = lines.reduce((n, l) => n + l.length, 0);
      if (lines.length > MAX_SYNC_LINES || totalChars > MAX_SYNC_CHARS) {
        syncLines = lines.slice(0, MAX_SYNC_LINES);
      }
      void extHostDocs.$acceptModelOpened({
        uri: conv.uriToDto(model.uri),
        languageId: model.getLanguageId(),
        versionId: model.getVersionId(),
        lines: syncLines,
        eol: model.getEOL(),
      });
    }, 0);

    const changeSub = model.onDidChangeContent((e) => {
      if (!this.shouldSyncModel(model)) return;
      const state = this.modelSyncs.get(key);
      if (!state) return;
      for (const c of e.changes) {
        state.pendingChanges.push({
          range: conv.fromMonacoRange(c.range),
          text: c.text,
        });
      }
      this.scheduleModelFlush(model);
    });
    this.modelSyncs.set(key, { changeSub, flushTimer: undefined, pendingChanges: [] });
  }

  private scheduleModelFlush(model: monaco.editor.ITextModel): void {
    const key = model.uri.toString();
    const state = this.modelSyncs.get(key);
    if (!state || !this.rpc) return;
    if (state.flushTimer) return;
    const CHANGE_DEBOUNCE_MS = 50;
    state.flushTimer = setTimeout(() => this.flushModelChanges(model), CHANGE_DEBOUNCE_MS);
  }

  private flushModelChanges(model: monaco.editor.ITextModel): void {
    if (!this.rpc) return;
    const extHostDocs = this.rpc.getProxy(ExtHostContext.ExtHostDocuments);
    const key = model.uri.toString();
    const state = this.modelSyncs.get(key);
    if (!state || state.pendingChanges.length === 0) return;
    const changes = state.pendingChanges;
    state.pendingChanges = [];
    state.flushTimer = undefined;
    const event: ModelChangedEventDto = {
      uri: conv.uriToDto(model.uri),
      versionId: model.getVersionId(),
      eol: model.getEOL(),
      changes,
    };
    void extHostDocs.$acceptModelChanged(event);
  }

  private closeModelSync(model: monaco.editor.ITextModel): void {
    const key = model.uri.toString();
    const state = this.modelSyncs.get(key);
    if (!state) return;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.changeSub.dispose();
    this.modelSyncs.delete(key);
  }

  /** Push currently-open Monaco models to the host and keep them in sync. */
  private wireDocumentSync(): void {
    const extHostDocs = this.rpc!.getProxy(ExtHostContext.ExtHostDocuments);

    const openModel = (model: monaco.editor.ITextModel) => {
      this.ensureModelSynced(model);
    };

    for (const model of monaco.editor.getModels()) openModel(model);
    this.disposables.push(monaco.editor.onDidCreateModel(openModel));
    this.disposables.push(
      monaco.editor.onWillDisposeModel((model) => {
        this.flushModelChanges(model);
        this.closeModelSync(model);
        void extHostDocs.$acceptModelClosed(conv.uriToDto(model.uri));
      }),
    );
    this.disposables.push({
      dispose: () => {
        for (const state of this.modelSyncs.values()) {
          if (state.flushTimer) clearTimeout(state.flushTimer);
          state.changeSub.dispose();
        }
        this.modelSyncs.clear();
        this.activeModelKey = null;
      },
    });
  }

  /** Execute a command id (UI: tree items, status bar, menus, palette). */
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    if (!this.handles) throw new Error("extension host not started");
    return this.handles.commands.execute(id, args);
  }

  listCommands(): string[] {
    return this.handles?.commands.list() ?? [];
  }

  /** Fire an activation event (e.g. onLanguage:python, onCommand:foo). */
  async activateByEvent(event: string): Promise<void> {
    if (!this.rpc) return;
    const extHost = this.rpc.getProxy(ExtHostContext.ExtHostExtensionService);
    await extHost.$activateByEvent(event);
  }

  /** Post a message from a webview iframe back to the owning extension. */
  postWebviewMessage(handle: string, message: unknown): void {
    this.handles?.webviews.postToExtension(handle, message);
  }

  /** Lazily fetch a tree view node's children from the owning extension. */
  async getTreeChildren(viewId: string, parentHandle?: string) {
    if (!this.rpc) return [];
    const proxy = this.rpc.getProxy(ExtHostContext.ExtHostTreeViews);
    return proxy.$getChildren(viewId, parentHandle);
  }

  /** Ask the extension's test controller to run the given test ids. */
  async runTests(controllerId: string, testIds: string[]): Promise<void> {
    if (!this.rpc) return;
    const proxy = this.rpc.getProxy(ExtHostContext.ExtHostTesting);
    await proxy.$runTests(controllerId, testIds);
  }

  /** View types for which an extension registered a notebook serializer. */
  notebookViewTypes(): string[] {
    return this.handles?.notebook.viewTypes() ?? [];
  }

  /** Ask the owning extension to parse raw notebook bytes into cells. */
  async deserializeNotebook(viewType: string, content: string) {
    if (!this.rpc) throw new Error("extension host not started");
    const proxy = this.rpc.getProxy(ExtHostContext.ExtHostNotebook);
    return proxy.$deserializeNotebook(viewType, content);
  }

  /** Ask the owning extension to serialize cells back into file content. */
  async serializeNotebook(viewType: string, doc: import("./common/dto").NotebookDocumentDto): Promise<string> {
    if (!this.rpc) throw new Error("extension host not started");
    const proxy = this.rpc.getProxy(ExtHostContext.ExtHostNotebook);
    return proxy.$serializeNotebook(viewType, doc);
  }

  async stop(): Promise<void> {
    return this.runExclusive(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    if (!this.started && !this.rpc && !this.transport) {
      composerDbg("extensionService.stopInternal skipped (not running)");
      return;
    }
    composerDbg("extensionService.stopInternal", {
      started: this.started,
      projectDir: this.projectDir,
      stack: new Error().stack?.split("\n").slice(1, 6).join(" | "),
    });
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rpc?.dispose();
    this.rpc = undefined;
    this.transport?.dispose();
    this.transport = undefined;
    this.handles = undefined;
    this.started = false;
    extensionUiStore.setRunning(false);
    try {
      await invoke("ext_host_stop");
    } catch {
      /* ignore */
    }
  }
}

export const extensionService = new ExtensionService();
