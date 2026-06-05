// ExtHostWindow: messages, status bar items, output channels, quick input, and
// terminals. Each delegates to its MainThread* counterpart on the renderer.

import { IRPCProtocol } from "../common/proxyIdentifier";
import {
  MainContext,
  MainThreadMessageServiceShape,
  MainThreadOutputShape,
  MainThreadQuickOpenShape,
  MainThreadStatusBarShape,
  MainThreadTerminalShape,
} from "../common/protocol";
import { CancellationTokenSource, Disposable, StatusBarAlignment } from "./types-impl";

export class StatusBarItem {
  text = "";
  tooltip?: string;
  command?: string;
  color?: string;
  private visible = false;
  constructor(
    public readonly id: string,
    public readonly alignment: StatusBarAlignment,
    public readonly priority: number,
    private readonly proxy: MainThreadStatusBarShape,
  ) {}
  show(): void {
    this.visible = true;
    this.sync();
  }
  hide(): void {
    this.visible = false;
    this.proxy.$dispose(this.id);
  }
  private sync(): void {
    if (!this.visible) return;
    this.proxy.$setEntry({
      id: this.id,
      text: this.text,
      tooltip: this.tooltip,
      command: this.command,
      alignment: this.alignment,
      priority: this.priority,
      color: this.color,
    });
  }
  dispose(): void {
    this.proxy.$dispose(this.id);
  }
}

export class OutputChannel {
  constructor(public readonly name: string, private readonly id: string, private readonly proxy: MainThreadOutputShape) {
    this.proxy.$register(id, name);
  }
  append(value: string): void {
    this.proxy.$append(this.id, value);
  }
  appendLine(value: string): void {
    this.proxy.$append(this.id, value + "\n");
  }
  clear(): void {
    this.proxy.$clear(this.id);
  }
  show(preserveFocus?: boolean): void {
    this.proxy.$show(this.id, !!preserveFocus);
  }
  hide(): void {
    /* no-op */
  }
  replace(value: string): void {
    this.clear();
    this.append(value);
  }
  dispose(): void {
    /* channels persist */
  }
}

export class Terminal {
  constructor(public readonly name: string, private readonly id: string, private readonly proxy: MainThreadTerminalShape) {}
  sendText(text: string, addNewLine = true): void {
    this.proxy.$sendText(this.id, text, addNewLine);
  }
  show(): void {
    this.proxy.$show(this.id);
  }
  hide(): void {
    /* no-op */
  }
  dispose(): void {
    this.proxy.$dispose(this.id);
  }
}

export class ExtHostWindow {
  private readonly msgProxy: MainThreadMessageServiceShape;
  private readonly statusProxy: MainThreadStatusBarShape;
  private readonly outputProxy: MainThreadOutputShape;
  private readonly quickProxy: MainThreadQuickOpenShape;
  private readonly terminalProxy: MainThreadTerminalShape;
  private statusSeq = 0;
  private quickSeq = 0;

  constructor(rpc: IRPCProtocol) {
    this.msgProxy = rpc.getProxy(MainContext.MainThreadMessageService);
    this.statusProxy = rpc.getProxy(MainContext.MainThreadStatusBar);
    this.outputProxy = rpc.getProxy(MainContext.MainThreadOutput);
    this.quickProxy = rpc.getProxy(MainContext.MainThreadQuickOpen);
    this.terminalProxy = rpc.getProxy(MainContext.MainThreadTerminal);
  }

  private showMessage(severity: number, message: string, rest: unknown[]): Promise<string | undefined> {
    let options = {};
    let items: string[];
    if (rest.length && typeof rest[0] === "object" && rest[0] !== null && !Array.isArray(rest[0])) {
      options = rest[0] as object;
      items = rest.slice(1) as string[];
    } else {
      items = rest as string[];
    }
    return this.msgProxy.$showMessage(severity, message, options, items.map(String));
  }
  showInformationMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.showMessage(2, message, rest);
  }
  showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.showMessage(1, message, rest);
  }
  showErrorMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.showMessage(0, message, rest);
  }

  createStatusBarItem(alignment: StatusBarAlignment = StatusBarAlignment.Left, priority = 0): StatusBarItem {
    return new StatusBarItem(`status-${this.statusSeq++}`, alignment, priority, this.statusProxy);
  }

  createOutputChannel(name: string): OutputChannel {
    return new OutputChannel(name, `output-${name}`, this.outputProxy);
  }

  async showQuickPick(items: unknown, options?: { placeHolder?: string; canPickMany?: boolean }): Promise<unknown> {
    const resolved = await Promise.resolve(items);
    const list = (resolved as unknown[]).map((it) =>
      typeof it === "string" ? { label: it } : (it as { label: string; description?: string; detail?: string }),
    );
    const result = await this.quickProxy.$showQuickPick(this.quickSeq++, list, options?.placeHolder, !!options?.canPickMany);
    if (!result) return undefined;
    // Map back to original string items where applicable.
    const pickLabel = (r: { label: string }) => {
      const original = (resolved as unknown[]).find((it) => (typeof it === "string" ? it === r.label : (it as { label: string }).label === r.label));
      return original ?? r;
    };
    return Array.isArray(result) ? result.map(pickLabel) : pickLabel(result);
  }

  showInputBox(options?: { prompt?: string; value?: string; placeHolder?: string; password?: boolean }): Promise<string | undefined> {
    return this.quickProxy.$showInputBox(options?.prompt, options?.value, options?.placeHolder, !!options?.password);
  }

  createTerminal(nameOrOptions?: string | { name?: string }): Terminal {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.name ?? "Extension";
    const id = `term-${Math.random().toString(36).slice(2)}`;
    void this.terminalProxy.$createTerminal(id, name);
    return new Terminal(name, id, this.terminalProxy);
  }

  setStatusBarMessage(text: string): Disposable {
    const item = this.createStatusBarItem();
    item.text = text;
    item.show();
    return new Disposable(() => item.dispose());
  }

  withProgress<R>(_options: unknown, task: (progress: { report: (v: unknown) => void }, token: unknown) => Thenable<R>): Thenable<R> {
    return task({ report: () => undefined }, new CancellationTokenSource().token);
  }
}
