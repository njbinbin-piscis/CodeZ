// Observable debug-session state for the Debug panel UI.

export interface StackFrame {
  id: number;
  name: string;
  line: number;
  source?: string;
}

export interface Variable {
  name: string;
  value: string;
  variablesReference: number;
}

export interface DebugSnapshot {
  active: boolean;
  running: boolean; // true = running, false = stopped at a breakpoint
  threadId: number | null;
  frames: StackFrame[];
  variables: Variable[];
  output: string[];
}

const EMPTY: DebugSnapshot = {
  active: false,
  running: false,
  threadId: null,
  frames: [],
  variables: [],
  output: [],
};

class DebugStore {
  private listeners = new Set<() => void>();
  private state: DebugSnapshot = EMPTY;
  private snapshot: DebugSnapshot = EMPTY;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): DebugSnapshot => this.snapshot;

  private commit(next: Partial<DebugSnapshot>): void {
    this.state = { ...this.state, ...next };
    this.snapshot = { ...this.state, frames: [...this.state.frames], variables: [...this.state.variables], output: [...this.state.output] };
    for (const l of this.listeners) l();
  }

  start(): void {
    this.state = { ...EMPTY, active: true, running: true };
    this.commit({});
  }
  setRunning(running: boolean): void {
    this.commit({ running });
  }
  setStopped(threadId: number, frames: StackFrame[]): void {
    this.commit({ running: false, threadId, frames });
  }
  setVariables(variables: Variable[]): void {
    this.commit({ variables });
  }
  appendOutput(line: string): void {
    this.state.output.push(line);
    if (this.state.output.length > 1000) this.state.output.shift();
    this.commit({});
  }
  end(): void {
    this.commit({ active: false, running: false, threadId: null, frames: [], variables: [] });
  }
}

export const debugStore = new DebugStore();
