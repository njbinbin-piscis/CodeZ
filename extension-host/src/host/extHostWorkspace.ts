// ExtHostWorkspace + configuration + filesystem + diagnostics, backed by the
// renderer's MainThreadWorkspace (which proxies to the Tauri host fs/git).

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import {
  ExtHostConfigurationShape,
  ExtHostWorkspaceShape,
  MainContext,
  MainThreadDiagnosticsShape,
  MainThreadWorkspaceShape,
} from "../common/protocol";
import * as conv from "./converters";
import { Diagnostic, Disposable, EventEmitter, Uri } from "./types-impl";

export class WorkspaceConfiguration {
  constructor(
    private readonly section: string | undefined,
    private readonly data: Record<string, unknown>,
    private readonly proxy: MainThreadWorkspaceShape,
  ) {}
  private key(k: string): string {
    return this.section ? `${this.section}.${k}` : k;
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    const full = this.key(key);
    if (full in this.data) return this.data[full] as T;
    if (this.section && this.section in this.data) {
      const sub = this.data[this.section] as Record<string, unknown> | undefined;
      if (sub && key in sub) return sub[key] as T;
    }
    return defaultValue;
  }
  has(key: string): boolean {
    return this.key(key) in this.data;
  }
  inspect(): undefined {
    return undefined;
  }
  update(key: string, value: unknown, target = 1): Promise<void> {
    return this.proxy.$updateConfiguration(this.key(key), value, target as number);
  }
}

export class DiagnosticCollection {
  constructor(public readonly name: string, private readonly proxy: MainThreadDiagnosticsShape) {}
  private store = new Map<string, Diagnostic[]>();
  set(uri: Uri, diagnostics?: Diagnostic[]): void {
    if (!diagnostics) {
      this.store.delete(uri.toString());
    } else {
      this.store.set(uri.toString(), diagnostics);
    }
    this.flush();
  }
  delete(uri: Uri): void {
    this.store.delete(uri.toString());
    this.flush();
  }
  clear(): void {
    this.store.clear();
    this.proxy.$clear(this.name);
  }
  dispose(): void {
    this.clear();
  }
  private flush(): void {
    const entries: [dto.UriComponents, dto.DiagnosticDto[]][] = [];
    for (const [key, diags] of this.store) {
      entries.push([Uri.parse(key).toJSON(), diags.map(conv.fromDiagnostic)]);
    }
    this.proxy.$changeMany(this.name, entries);
  }
}

export class ExtHostFileSystem {
  constructor(private readonly proxy: MainThreadWorkspaceShape) {}
  async readFile(uri: Uri): Promise<Uint8Array> {
    const text = await this.proxy.$readFile(uri.toJSON());
    return new TextEncoder().encode(text);
  }
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    await this.proxy.$writeFile(uri.toJSON(), new TextDecoder().decode(content));
  }
  async stat(uri: Uri): Promise<{ type: number; size: number } | null> {
    return this.proxy.$stat(uri.toJSON());
  }
  async readDirectory(uri: Uri): Promise<[string, number][]> {
    return this.proxy.$readDirectory(uri.toJSON());
  }
  async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
    await this.proxy.$delete(uri.toJSON(), options?.recursive ?? false);
  }
}

export class ExtHostWorkspace implements ExtHostWorkspaceShape, ExtHostConfigurationShape {
  private readonly proxy: MainThreadWorkspaceShape;
  private readonly diagProxy: MainThreadDiagnosticsShape;
  private folders: Uri[] = [];
  private configData: Record<string, unknown> = {};

  readonly onDidChangeConfigurationEmitter = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();
  readonly onDidChangeWorkspaceFoldersEmitter = new EventEmitter<void>();

  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadWorkspace);
    this.diagProxy = rpc.getProxy(MainContext.MainThreadDiagnostics);
  }

  initialize(folders: dto.UriComponents[], config: Record<string, unknown>): void {
    this.folders = folders.map(Uri.from);
    this.configData = config;
  }

  get workspaceFolders(): { uri: Uri; name: string; index: number }[] {
    return this.folders.map((uri, index) => ({ uri, name: uri.path.split("/").pop() ?? uri.path, index }));
  }
  get rootPath(): string | undefined {
    return this.folders[0]?.fsPath;
  }

  getConfiguration(section?: string): WorkspaceConfiguration {
    return new WorkspaceConfiguration(section, this.configData, this.proxy);
  }

  getWorkspaceFolder(uri: Uri): { uri: Uri; name: string; index: number } | undefined {
    return this.workspaceFolders.find((f) => uri.path.startsWith(f.uri.path));
  }

  async findFiles(include: string, exclude?: string, maxResults = 1000): Promise<Uri[]> {
    const result = await this.proxy.$findFiles(include, exclude, maxResults);
    return result.map(Uri.from);
  }

  applyEdit(): Promise<boolean> {
    return Promise.resolve(false);
  }

  createDiagnosticCollection(name?: string): DiagnosticCollection {
    return new DiagnosticCollection(name ?? `diag-${Math.random().toString(36).slice(2)}`, this.diagProxy);
  }

  createFileSystem(): ExtHostFileSystem {
    return new ExtHostFileSystem(this.proxy);
  }

  registerFileSystemWatcher(): Disposable {
    return new Disposable(() => undefined);
  }

  $acceptConfigurationChanged(data: Record<string, unknown>): void {
    this.configData = data;
    this.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (s: string) => s in data });
  }

  $acceptWorkspaceFoldersChanged(folders: dto.UriComponents[]): void {
    this.folders = folders.map(Uri.from);
    this.onDidChangeWorkspaceFoldersEmitter.fire();
  }
}
