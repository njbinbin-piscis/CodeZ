// Orchestrates a debug session: resolves a debug adapter, runs the DAP
// handshake, pushes breakpoints, and routes DAP events into the debug store.
//
// Adapter resolution: a launch config may carry `{ __adapter: {command, args} }`
// (e.g. provided by a debug-adapter extension via its descriptor factory).
// Otherwise a few common defaults are used. Actual debugging requires a real
// adapter to be installed/available on the machine.

import { DapClient } from "./dapClient";
import { breakpointStore } from "./breakpoints";
import { debugStore, type StackFrame, type Variable } from "./debugStore";
import { extensionUiStore } from "../extensionUiStore";

interface DebugConfig {
  type: string;
  name: string;
  request: string;
  program?: string;
  cwd?: string;
  __adapter?: { command: string; args?: string[] };
  [key: string]: unknown;
}

function resolveAdapter(config: DebugConfig): { command: string; args: string[] } | null {
  if (config.__adapter?.command) {
    return { command: config.__adapter.command, args: config.__adapter.args ?? [] };
  }
  // Common conventions; a real adapter binary must exist on PATH.
  switch (config.type) {
    case "node":
    case "pwa-node":
      return { command: "node", args: ["--stdio"] }; // placeholder; real js-debug ships with the extension
    case "python":
    case "debugpy":
      return { command: "python", args: ["-m", "debugpy.adapter"] };
    case "lldb":
    case "codelldb":
      return { command: "codelldb", args: [] };
    default:
      return null;
  }
}

class DebugController {
  private client: DapClient | undefined;

  constructor() {
    window.addEventListener("agentz-debug-start", (e) => {
      void this.start((e as CustomEvent).detail as DebugConfig);
    });
  }

  get isActive(): boolean {
    return !!this.client;
  }

  async start(config: DebugConfig): Promise<void> {
    await this.stop();
    const adapter = resolveAdapter(config);
    if (!adapter) {
      extensionUiStore.appendDebugOutput(`No debug adapter resolved for type "${config.type}". Install a debug extension.`);
      return;
    }
    this.client = new DapClient();
    debugStore.start();
    extensionUiStore.appendDebugOutput(`Launching adapter: ${adapter.command} ${adapter.args.join(" ")}`);

    this.client.onLog((line) => extensionUiStore.appendDebugOutput(line));
    this.client.onEvent((event, body) => void this.onEvent(event, body));

    try {
      await this.client.connect(adapter.command, adapter.args, config.cwd);
      await this.client.request("initialize", {
        clientID: "agentz",
        adapterID: config.type,
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsRunInTerminalRequest: false,
      });
      await this.sendBreakpoints();
      if (config.request === "attach") {
        await this.client.request("attach", config as unknown as Record<string, unknown>);
      } else {
        await this.client.request("launch", config as unknown as Record<string, unknown>);
      }
      await this.client.request("configurationDone").catch(() => undefined);
    } catch (err) {
      extensionUiStore.appendDebugOutput(`Debug start failed: ${String(err)}`);
      await this.stop();
    }
  }

  private async sendBreakpoints(): Promise<void> {
    if (!this.client) return;
    for (const [path, lines] of breakpointStore.all()) {
      await this.client
        .request("setBreakpoints", {
          source: { path, name: path.split("/").pop() },
          breakpoints: [...lines].map((line) => ({ line })),
        })
        .catch(() => undefined);
    }
  }

  private async onEvent(event: string, body: unknown): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    switch (event) {
      case "output":
        extensionUiStore.appendDebugOutput(String(b.output ?? ""));
        debugStore.appendOutput(String(b.output ?? ""));
        break;
      case "stopped":
        await this.onStopped(Number(b.threadId ?? 1));
        break;
      case "continued":
        debugStore.setRunning(true);
        break;
      case "terminated":
      case "exited":
        extensionUiStore.appendDebugOutput("Debug session ended.");
        await this.stop();
        break;
    }
  }

  private async onStopped(threadId: number): Promise<void> {
    if (!this.client) return;
    try {
      const stack = (await this.client.request("stackTrace", { threadId, levels: 20 })) as {
        stackFrames?: { id: number; name: string; line: number; source?: { path?: string } }[];
      };
      const frames: StackFrame[] = (stack.stackFrames ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        line: f.line,
        source: f.source?.path,
      }));
      debugStore.setStopped(threadId, frames);
      if (frames[0]) await this.loadVariables(frames[0].id);
    } catch (err) {
      extensionUiStore.appendDebugOutput(`stackTrace failed: ${String(err)}`);
    }
  }

  private async loadVariables(frameId: number): Promise<void> {
    if (!this.client) return;
    try {
      const scopes = (await this.client.request("scopes", { frameId })) as {
        scopes?: { variablesReference: number }[];
      };
      const ref = scopes.scopes?.[0]?.variablesReference;
      if (!ref) return;
      const vars = (await this.client.request("variables", { variablesReference: ref })) as {
        variables?: Variable[];
      };
      debugStore.setVariables(vars.variables ?? []);
    } catch {
      /* ignore */
    }
  }

  async continue(): Promise<void> {
    await this.step("continue");
  }
  async stepOver(): Promise<void> {
    await this.step("next");
  }
  async stepInto(): Promise<void> {
    await this.step("stepIn");
  }
  async stepOut(): Promise<void> {
    await this.step("stepOut");
  }
  private async step(command: string): Promise<void> {
    if (!this.client) return;
    const threadId = debugStore.getSnapshot().threadId ?? 1;
    debugStore.setRunning(true);
    await this.client.request(command, { threadId }).catch((e) => extensionUiStore.appendDebugOutput(String(e)));
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.request("disconnect", { terminateDebuggee: true }).catch(() => undefined);
      await this.client.dispose();
      this.client = undefined;
    }
    debugStore.end();
  }
}

export const debugController = new DebugController();
