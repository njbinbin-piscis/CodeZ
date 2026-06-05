// Renderer copy of the proxy-identifier core. MUST stay wire-compatible with
// extension-host/src/common/proxyIdentifier.ts (identifiers are assigned by
// registration order, which is identical because protocol.ts mirrors the host).

export interface ProxyIdentifier<T> {
  readonly sid: string;
  readonly nid: number;
  /** Phantom type marker (never set) so `T` participates in the type. */
  readonly _proxyBrand?: T;
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
