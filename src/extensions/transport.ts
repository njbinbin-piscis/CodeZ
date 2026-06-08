// Renderer transport: brokers RPC frames to the Node extension host through the
// Tauri host. Outbound frames go via the `ext_host_send` command; inbound
// frames arrive on the `agentz:ext-host` event channel.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ITransport, RpcMessage } from "./common/rpcProtocol";

interface ExtHostEvent {
  channel: "message" | "log" | "exit";
  data: string;
}

export class TauriExtHostTransport implements ITransport {
  private handler: ((m: RpcMessage) => void) | undefined;
  private lostHandler: ((reason: string) => void) | undefined;
  private unlisten: UnlistenFn | undefined;
  private logSink: (line: string) => void;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((err: Error) => void) | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private hostReady = false;
  private dead = false;

  constructor(logSink?: (line: string) => void) {
    this.logSink = logSink ?? ((line) => console.debug("[ext-host]", line));
  }

  async connect(): Promise<void> {
    this.dead = false;
    this.hostReady = false;
    this.unlisten = await listen<ExtHostEvent>("agentz:ext-host", (event) => {
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
        if (this.isHostReadyLog(data)) {
          this.markHostReady();
        }
      } else if (channel === "exit") {
        const reason = `extension host exited: ${data}`;
        this.logSink(reason);
        this.markDead(reason);
      }
    });
  }

  /**
   * Wait until the Node sidecar logs that it is ready for $initialize.
   * Call before `ext_host_start` so the ready line is not missed.
   */
  waitForReady(timeoutMs = 15_000): Promise<void> {
    if (this.hostReady) return Promise.resolve();
    this.clearReadyWait();
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.clearReadyWait();
        reject(new Error(`extension host ready timeout (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  onConnectionLost(handler: (reason: string) => void): void {
    this.lostHandler = handler;
  }

  send(message: RpcMessage): void {
    if (this.dead) return;
    void invoke("ext_host_send", { message: JSON.stringify(message) }).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.markDead(reason);
    });
  }

  onMessage(handler: (m: RpcMessage) => void): void {
    this.handler = handler;
  }

  dispose(): void {
    this.clearReadyWait();
    this.unlisten?.();
    this.unlisten = undefined;
    this.dead = true;
    this.hostReady = false;
  }

  private isHostReadyLog(line: string): boolean {
    return line.includes("ready, awaiting $initialize") || line.includes("[host] ready");
  }

  private markHostReady(): void {
    this.hostReady = true;
    this.readyResolve?.();
    this.clearReadyWait();
  }

  private clearReadyWait(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.readyReject?.(new Error(reason));
    this.clearReadyWait();
    this.lostHandler?.(reason);
  }
}
