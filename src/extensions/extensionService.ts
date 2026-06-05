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

const CONFIG_KEY = "codez.ext.config";

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
  projectDir = "";

  get isRunning(): boolean {
    return this.started;
  }

  /** Boot the extension host for a project and activate startup extensions. */
  async start(projectDir: string): Promise<void> {
    if (this.started) await this.stop();
    this.projectDir = projectDir;

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
        contributes: (e.contributes as Record<string, unknown>) ?? undefined,
      }));

    // No enabled extensions → don't pay the cost of booting the Node sidecar
    // (and don't surface a spurious "host error" on a fresh install). The host
    // is started lazily the next time a project opens with extensions present.
    if (extensions.length === 0) {
      extensionUiStore.setRunning(false);
      return;
    }

    this.transport = new TauriExtHostTransport((line) => extensionUiStore.appendHostLog(line));
    await this.transport.connect();

    // Launch the Node sidecar (must happen after we listen for its output).
    await invoke("ext_host_start", { projectDir });

    this.rpc = new RPCProtocol(this.transport);
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

    this.wireDocumentSync();

    const extHost = this.rpc.getProxy(ExtHostContext.ExtHostExtensionService);
    const report = await extHost.$initialize(initData);
    compatStore.setReport(report);

    this.started = true;
    extensionUiStore.setRunning(true);
  }

  /** Push currently-open Monaco models to the host and keep them in sync. */
  private wireDocumentSync(): void {
    const extHostDocs = this.rpc!.getProxy(ExtHostContext.ExtHostDocuments);

    const openModel = (model: monaco.editor.ITextModel) => {
      if (model.uri.scheme === "inmemory") return;
      extHostDocs.$acceptModelOpened({
        uri: conv.uriToDto(model.uri),
        languageId: model.getLanguageId(),
        versionId: model.getVersionId(),
        lines: model.getLinesContent(),
        eol: model.getEOL(),
      });
      const changeSub = model.onDidChangeContent((e) => {
        const event: ModelChangedEventDto = {
          uri: conv.uriToDto(model.uri),
          versionId: model.getVersionId(),
          eol: model.getEOL(),
          changes: e.changes.map((c) => ({ range: conv.fromMonacoRange(c.range), text: c.text })),
        };
        extHostDocs.$acceptModelChanged(event);
      });
      this.disposables.push(changeSub);
    };

    for (const model of monaco.editor.getModels()) openModel(model);
    this.disposables.push(monaco.editor.onDidCreateModel(openModel));
    this.disposables.push(
      monaco.editor.onWillDisposeModel((model) => {
        extHostDocs.$acceptModelClosed(conv.uriToDto(model.uri));
      }),
    );
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
