// Debug Adapter Protocol client. Speaks DAP over the Tauri DAP broker: requests
// go out via the `dap_send` command; responses + events arrive on `codez:dap`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface DapEvent {
  channel: "message" | "log" | "exit";
  data: string;
}

export interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  [key: string]: unknown;
}

type EventHandler = (event: string, body: unknown) => void;
type LogHandler = (line: string) => void;

export class DapClient {
  private seq = 1;
  private unlisten: UnlistenFn | undefined;
  private pending = new Map<number, { resolve: (b: unknown) => void; reject: (e: Error) => void }>();
  private eventHandler: EventHandler | undefined;
  private logHandler: LogHandler | undefined;

  async connect(command: string, args: string[], cwd?: string): Promise<void> {
    this.unlisten = await listen<DapEvent>("codez:dap", (e) => {
      const { channel, data } = e.payload;
      if (channel === "message") this.onMessage(data);
      else if (channel === "log") this.logHandler?.(data);
      else if (channel === "exit") this.eventHandler?.("exited", { reason: data });
    });
    await invoke("dap_start", { command, args, cwd });
  }

  onEvent(handler: EventHandler): void {
    this.eventHandler = handler;
  }
  onLog(handler: LogHandler): void {
    this.logHandler = handler;
  }

  private onMessage(raw: string): void {
    let msg: DapMessage;
    try {
      msg = JSON.parse(raw) as DapMessage;
    } catch {
      return;
    }
    if (msg.type === "response") {
      const reqSeq = msg.request_seq as number;
      const pending = this.pending.get(reqSeq);
      if (pending) {
        this.pending.delete(reqSeq);
        if (msg.success) pending.resolve(msg.body);
        else pending.reject(new Error((msg.message as string) ?? "DAP request failed"));
      }
    } else if (msg.type === "event") {
      this.eventHandler?.(msg.event as string, msg.body);
    }
  }

  request<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    const seq = this.seq++;
    const message = JSON.stringify({ seq, type: "request", command, arguments: args ?? {} });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (b: unknown) => void, reject });
      void invoke("dap_send", { message }).catch(reject);
    });
  }

  async dispose(): Promise<void> {
    this.unlisten?.();
    this.unlisten = undefined;
    for (const p of this.pending.values()) p.reject(new Error("DAP disposed"));
    this.pending.clear();
    try {
      await invoke("dap_stop");
    } catch {
      /* ignore */
    }
  }
}
