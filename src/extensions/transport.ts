// Renderer transport: brokers RPC frames to the Node extension host through the
// Tauri host. Outbound frames go via the `ext_host_send` command; inbound
// frames arrive on the `codez:ext-host` event channel.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ITransport, RpcMessage } from "./common/rpcProtocol";

interface ExtHostEvent {
  channel: "message" | "log" | "exit";
  data: string;
}

export class TauriExtHostTransport implements ITransport {
  private handler: ((m: RpcMessage) => void) | undefined;
  private unlisten: UnlistenFn | undefined;
  private logSink: (line: string) => void;

  constructor(logSink?: (line: string) => void) {
    this.logSink = logSink ?? ((line) => console.debug("[ext-host]", line));
  }

  async connect(): Promise<void> {
    this.unlisten = await listen<ExtHostEvent>("codez:ext-host", (event) => {
      const { channel, data } = event.payload;
      if (channel === "message") {
        try {
          const msg = JSON.parse(data) as RpcMessage;
          this.handler?.(msg);
        } catch (err) {
          console.error("[ext-host] bad RPC frame", err, data);
        }
      } else if (channel === "log") {
        this.logSink(data);
      } else if (channel === "exit") {
        this.logSink(`host exited: ${data}`);
      }
    });
  }

  send(message: RpcMessage): void {
    void invoke("ext_host_send", { message: JSON.stringify(message) });
  }

  onMessage(handler: (m: RpcMessage) => void): void {
    this.handler = handler;
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = undefined;
  }
}
