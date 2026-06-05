// Typed proxy identifiers — the tokens that connect an ExtHost* service to its
// MainThread* counterpart (mirrors VS Code's proxyIdentifier.ts).

export interface ProxyIdentifier<T> {
  readonly sid: string;
  readonly nid: number;
}

const identifiers: ProxyIdentifier<unknown>[] = [];

export function createProxyIdentifier<T>(sid: string): ProxyIdentifier<T> {
  const nid = identifiers.length;
  const id: ProxyIdentifier<T> = { sid, nid };
  identifiers.push(id as ProxyIdentifier<unknown>);
  return id;
}

export type Proxied<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R extends Promise<unknown> ? R : Promise<R>
    : never;
};

export interface IRPCProtocol {
  getProxy<T>(identifier: ProxyIdentifier<T>): Proxied<T>;
  set<T, R extends T>(identifier: ProxyIdentifier<T>, value: R): R;
  dispose(): void;
}
