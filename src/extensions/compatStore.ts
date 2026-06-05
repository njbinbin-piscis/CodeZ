// Observable compatibility report: the host's engines/proposed-API verdicts
// plus any MainThread APIs the host invoked that the renderer doesn't implement.

import { MainContext, type CompatReportDto, type ExtensionCompatDto } from "./common/protocol";

export interface CompatSnapshot {
  hostVersion: string;
  extensions: ExtensionCompatDto[];
  /** MainThread methods invoked by the host but not implemented here. */
  missingApis: string[];
}

const EMPTY: CompatSnapshot = { hostVersion: "", extensions: [], missingApis: [] };

// nid → human-readable proxy name (e.g. 4 → "MainThreadWebviews").
const proxyNames = new Map<number, string>();
for (const [name, id] of Object.entries(MainContext)) {
  proxyNames.set((id as { nid: number }).nid, name);
}

class CompatStore {
  private listeners = new Set<() => void>();
  private state: CompatSnapshot = EMPTY;
  private snapshot: CompatSnapshot = EMPTY;
  private missing = new Set<string>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): CompatSnapshot => this.snapshot;

  private commit(): void {
    this.snapshot = {
      hostVersion: this.state.hostVersion,
      extensions: [...this.state.extensions],
      missingApis: [...this.missing].sort(),
    };
    for (const l of this.listeners) l();
  }

  setReport(report: CompatReportDto): void {
    this.state = { ...this.state, hostVersion: report.hostVersion, extensions: report.extensions };
    this.commit();
  }

  recordMissing(proxyNid: number, method: string): void {
    const name = proxyNames.get(proxyNid) ?? `proxy#${proxyNid}`;
    const key = `${name}.${method}`;
    if (this.missing.has(key)) return;
    this.missing.add(key);
    this.commit();
  }

  reset(): void {
    this.state = EMPTY;
    this.missing.clear();
    this.commit();
  }

  /** Count of extensions the host refused to activate. */
  get incompatibleCount(): number {
    return this.snapshot.extensions.filter((e) => !e.compatible).length;
  }
}

export const compatStore = new CompatStore();
