// ExtHostTreeViews: backs vscode.window.createTreeView / registerTreeDataProvider.
// The renderer pulls children lazily via $getChildren.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostTreeViewsShape, MainContext, MainThreadTreeViewsShape } from "../common/protocol";
import * as conv from "./converters";
import { Disposable, EventEmitter, TreeItem } from "./types-impl";

interface TreeDataProvider {
  getTreeItem(element: unknown): TreeItem | Thenable<TreeItem>;
  getChildren(element?: unknown): unknown[] | Thenable<unknown[] | undefined> | undefined;
  onDidChangeTreeData?: (listener: () => void) => Disposable;
}

class TreeViewRegistration {
  // Map opaque element <-> stable handle so the renderer can request children.
  private handleToElement = new Map<string, unknown>();
  private seq = 0;
  constructor(public readonly viewId: string, public readonly provider: TreeDataProvider) {}

  newHandle(element: unknown): string {
    const handle = `${this.viewId}/${this.seq++}`;
    this.handleToElement.set(handle, element);
    return handle;
  }
  element(handle: string): unknown {
    return this.handleToElement.get(handle);
  }
  reset(): void {
    this.handleToElement.clear();
    this.seq = 0;
  }
}

export class ExtHostTreeViews implements ExtHostTreeViewsShape {
  private readonly proxy: MainThreadTreeViewsShape;
  private readonly registrations = new Map<string, TreeViewRegistration>();

  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadTreeViews);
  }

  registerTreeDataProvider(viewId: string, provider: TreeDataProvider): Disposable {
    const reg = new TreeViewRegistration(viewId, provider);
    this.registrations.set(viewId, reg);
    this.proxy.$registerView(viewId);
    const sub = provider.onDidChangeTreeData?.(() => this.refresh(viewId));
    return new Disposable(() => {
      this.registrations.delete(viewId);
      sub?.dispose();
    });
  }

  createTreeView(viewId: string, options: { treeDataProvider: TreeDataProvider }): { dispose(): void; reveal(): Promise<void> } {
    const d = this.registerTreeDataProvider(viewId, options.treeDataProvider);
    return { dispose: () => d.dispose(), reveal: () => Promise.resolve() };
  }

  private async refresh(viewId: string): Promise<void> {
    const reg = this.registrations.get(viewId);
    if (!reg) return;
    reg.reset();
    const items = await this.collect(reg, undefined);
    this.proxy.$refresh(viewId, items);
  }

  private async collect(reg: TreeViewRegistration, parent: unknown): Promise<dto.TreeItemDto[]> {
    const children = (await reg.provider.getChildren(parent)) ?? [];
    const out: dto.TreeItemDto[] = [];
    for (const child of children) {
      const item = await reg.provider.getTreeItem(child);
      const handle = reg.newHandle(child);
      out.push(conv.fromTreeItem(item, handle));
    }
    return out;
  }

  async $getChildren(viewId: string, parentHandle?: string): Promise<dto.TreeItemDto[]> {
    const reg = this.registrations.get(viewId);
    if (!reg) return [];
    const parent = parentHandle ? reg.element(parentHandle) : undefined;
    const children = (await reg.provider.getChildren(parent)) ?? [];
    const out: dto.TreeItemDto[] = [];
    for (const child of children) {
      const item = await reg.provider.getTreeItem(child);
      const handle = reg.newHandle(child);
      out.push(conv.fromTreeItem(item, handle, parentHandle));
    }
    return out;
  }

  async $resolveCommand(viewId: string, handle: string): Promise<dto.CommandDto | undefined> {
    const reg = this.registrations.get(viewId);
    if (!reg) return undefined;
    const element = reg.element(handle);
    if (element === undefined) return undefined;
    const item = await reg.provider.getTreeItem(element);
    return item.command ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments } : undefined;
  }

  // Re-export an EventEmitter type so apiFactory can hand one to extensions.
  static emitter<T>(): EventEmitter<T> {
    return new EventEmitter<T>();
  }
}
