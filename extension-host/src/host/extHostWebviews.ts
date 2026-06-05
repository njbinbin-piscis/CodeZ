// ExtHostWebviews: backs vscode.window.createWebviewPanel. HTML is pushed to the
// renderer which hosts it in a sandboxed iframe; messages flow both ways.

import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostWebviewsShape, MainContext, MainThreadWebviewsShape } from "../common/protocol";
import { Disposable, EventEmitter, ViewColumn } from "./types-impl";

class Webview {
  private _html = "";
  readonly onDidReceiveMessageEmitter = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.onDidReceiveMessageEmitter.event;
  options: { enableScripts?: boolean; retainContextWhenHidden?: boolean } = {};
  constructor(public readonly handle: string, private readonly proxy: MainThreadWebviewsShape) {}
  get html(): string {
    return this._html;
  }
  set html(value: string) {
    this._html = value;
    this.proxy.$setHtml(this.handle, value);
  }
  postMessage(message: unknown): Promise<boolean> {
    return this.proxy.$postMessage(this.handle, message);
  }
  asWebviewUri(uri: { toString(): string }): string {
    return uri.toString();
  }
  cspSource = "vscode-webview:";
}

class WebviewPanel {
  readonly webview: Webview;
  readonly onDidDisposeEmitter = new EventEmitter<void>();
  readonly onDidDispose = this.onDidDisposeEmitter.event;
  readonly onDidChangeViewStateEmitter = new EventEmitter<unknown>();
  readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;
  active = true;
  visible = true;
  private disposed = false;
  constructor(
    public readonly handle: string,
    public readonly viewType: string,
    public title: string,
    public readonly viewColumn: ViewColumn,
    webview: Webview,
    private readonly proxy: MainThreadWebviewsShape,
  ) {
    this.webview = webview;
  }
  reveal(): void {
    this.proxy.$createWebviewPanel({
      handle: this.handle,
      viewType: this.viewType,
      title: this.title,
      viewColumn: this.viewColumn,
      options: this.webview.options,
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proxy.$dispose(this.handle);
    this.onDidDisposeEmitter.fire();
  }
}

export class ExtHostWebviews implements ExtHostWebviewsShape {
  private readonly proxy: MainThreadWebviewsShape;
  private readonly panels = new Map<string, WebviewPanel>();
  private seq = 0;

  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadWebviews);
  }

  createWebviewPanel(viewType: string, title: string, showOptions: number | { viewColumn: number }, options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean }): WebviewPanel {
    const handle = `webview-${this.seq++}`;
    const viewColumn = typeof showOptions === "number" ? showOptions : showOptions.viewColumn;
    const webview = new Webview(handle, this.proxy);
    webview.options = options ?? {};
    const panel = new WebviewPanel(handle, viewType, title, viewColumn as ViewColumn, webview, this.proxy);
    this.panels.set(handle, panel);
    this.proxy.$createWebviewPanel({ handle, viewType, title, viewColumn, options: webview.options });
    return panel;
  }

  $onMessage(handle: string, message: unknown): void {
    this.panels.get(handle)?.webview.onDidReceiveMessageEmitter.fire(message);
  }

  $onDidDispose(handle: string): void {
    const panel = this.panels.get(handle);
    if (panel) {
      this.panels.delete(handle);
      panel.onDidDisposeEmitter.fire();
    }
  }

  registerWebviewViewProvider(): Disposable {
    return new Disposable(() => undefined);
  }
}
