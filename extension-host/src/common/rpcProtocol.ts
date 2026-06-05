// Minimal structured RPC protocol shared by the extension host (Node) and the
// main thread (renderer). Mirrors the role of VS Code's rpcProtocol.ts: route
// `$`-prefixed method calls across a process boundary via proxy objects.
//
// Wire format is line-delimited JSON; each message is one of:
//   { t: 1, i, p, m, a }  request  (id, proxyNid, method, args)
//   { t: 2, i, r }        reply ok (id, result)
//   { t: 3, i, e }        reply err(id, errorMessage)
//
// This file is duplicated verbatim on the renderer side (src/extensions/common)
// and MUST stay byte-compatible across the two.

import {
  IRPCProtocol,
  Proxied,
  ProxyIdentifier,
} from "./proxyIdentifier";

export const enum MessageType {
  Request = 1,
  ReplyOK = 2,
  ReplyErr = 3,
}

export interface RpcMessage {
  t: MessageType;
  i: number;
  p?: number;
  m?: string;
  a?: unknown[];
  r?: unknown;
  e?: string;
}

export interface ITransport {
  send(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class RPCProtocol implements IRPCProtocol {
  private readonly transport: ITransport;
  private readonly locals: { [nid: number]: unknown } = Object.create(null);
  private readonly proxies: { [nid: number]: unknown } = Object.create(null);
  private readonly pending = new Map<number, PendingCall>();
  private lastMessageId = 0;
  private disposed = false;

  constructor(transport: ITransport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.receive(msg));
  }

  getProxy<T>(identifier: ProxyIdentifier<T>): Proxied<T> {
    const nid = identifier.nid;
    if (!this.proxies[nid]) {
      this.proxies[nid] = this.createProxy(nid, identifier.sid);
    }
    return this.proxies[nid] as Proxied<T>;
  }

  set<T, R extends T>(identifier: ProxyIdentifier<T>, value: R): R {
    this.locals[identifier.nid] = value;
    return value;
  }

  private createProxy(nid: number, sid: string): unknown {
    const handler: ProxyHandler<Record<string, unknown>> = {
      get: (target, name) => {
        if (
          typeof name === "string" &&
          !target[name] &&
          name.charCodeAt(0) === 36 /* '$' */
        ) {
          target[name] = (...args: unknown[]) => this.remoteCall(nid, name, args);
        }
        return (target as Record<PropertyKey, unknown>)[name];
      },
    };
    void sid;
    return new Proxy(Object.create(null), handler);
  }

  private remoteCall(nid: number, method: string, args: unknown[]): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("RPCProtocol disposed"));
    }
    const id = ++this.lastMessageId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ t: MessageType.Request, i: id, p: nid, m: method, a: args });
    });
  }

  private receive(msg: RpcMessage): void {
    switch (msg.t) {
      case MessageType.Request:
        void this.handleRequest(msg);
        break;
      case MessageType.ReplyOK: {
        const pending = this.pending.get(msg.i);
        if (pending) {
          this.pending.delete(msg.i);
          pending.resolve(msg.r);
        }
        break;
      }
      case MessageType.ReplyErr: {
        const pending = this.pending.get(msg.i);
        if (pending) {
          this.pending.delete(msg.i);
          pending.reject(new Error(msg.e ?? "remote error"));
        }
        break;
      }
    }
  }

  private async handleRequest(msg: RpcMessage): Promise<void> {
    const target = this.locals[msg.p as number] as
      | Record<string, (...a: unknown[]) => unknown>
      | undefined;
    if (!target) {
      this.transport.send({
        t: MessageType.ReplyErr,
        i: msg.i,
        e: `no local actor for proxy ${msg.p}`,
      });
      return;
    }
    const fn = target[msg.m as string];
    if (typeof fn !== "function") {
      this.transport.send({
        t: MessageType.ReplyErr,
        i: msg.i,
        e: `actor ${msg.p} has no method ${msg.m}`,
      });
      return;
    }
    try {
      const result = await fn.apply(target, (msg.a ?? []) as unknown[]);
      this.transport.send({ t: MessageType.ReplyOK, i: msg.i, r: result ?? null });
    } catch (err) {
      this.transport.send({
        t: MessageType.ReplyErr,
        i: msg.i,
        e: err instanceof Error ? err.message : String(err),
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("RPCProtocol disposed"));
    }
    this.pending.clear();
  }
}
