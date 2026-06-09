/** Dev-only performance counters for diagnosing refresh / watcher storms. */

interface PerfSnapshot {
  watcherEventsReceived: number;
  watcherEventsIgnored: number;
  workspaceRefreshScheduled: number;
  workspaceRefreshFlushed: number;
  tabReloadScheduled: number;
}

const counters: PerfSnapshot = {
  watcherEventsReceived: 0,
  watcherEventsIgnored: 0,
  workspaceRefreshScheduled: 0,
  workspaceRefreshFlushed: 0,
  tabReloadScheduled: 0,
};

function enabled(): boolean {
  return import.meta.env.DEV;
}

export const perfCounters = {
  recordWatcherReceived(): void {
    if (enabled()) counters.watcherEventsReceived += 1;
  },
  recordWatcherIgnored(): void {
    if (enabled()) counters.watcherEventsIgnored += 1;
  },
  recordWorkspaceRefreshScheduled(): void {
    if (enabled()) counters.workspaceRefreshScheduled += 1;
  },
  recordWorkspaceRefreshFlushed(): void {
    if (enabled()) counters.workspaceRefreshFlushed += 1;
  },
  recordTabReloadScheduled(): void {
    if (enabled()) counters.tabReloadScheduled += 1;
  },
  snapshot(): PerfSnapshot {
    return { ...counters };
  },
  reset(): void {
    counters.watcherEventsReceived = 0;
    counters.watcherEventsIgnored = 0;
    counters.workspaceRefreshScheduled = 0;
    counters.workspaceRefreshFlushed = 0;
    counters.tabReloadScheduled = 0;
  },
};

if (import.meta.env.DEV && typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__agentz_perf = perfCounters;
}
