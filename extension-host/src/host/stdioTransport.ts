// Line-delimited-JSON transport over a Node stream pair (stdin/stdout). The
// Tauri host brokers these to the renderer's RPC protocol.

import { ITransport, RpcMessage } from "../common/rpcProtocol";

export class StdioTransport implements ITransport {
  private handler: ((m: RpcMessage) => void) | undefined;
  private buffer = "";

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string) => this.onData(chunk));
  }

  send(message: RpcMessage): void {
    this.output.write(JSON.stringify(message) + "\n");
  }

  onMessage(handler: (m: RpcMessage) => void): void {
    this.handler = handler;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        this.handler?.(msg);
      } catch (err) {
        process.stderr.write(`[host] bad RPC line: ${String(err)}\n`);
      }
    }
  }
}
