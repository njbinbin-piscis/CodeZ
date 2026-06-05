// ExtHostTask: backs vscode.tasks.* (registerTaskProvider, executeTask). Tasks
// are run by the renderer via the Tauri PTY terminal.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostTaskShape, MainContext, MainThreadTaskShape } from "../common/protocol";
import { Disposable } from "./types-impl";

interface TaskProvider {
  provideTasks(): unknown[] | Thenable<unknown[] | undefined> | undefined;
  resolveTask?(task: unknown): unknown;
}

function toTaskDto(task: any, source: string): dto.TaskDto {
  const exec = task.execution ?? {};
  return {
    id: task.name ?? `task-${Math.random().toString(36).slice(2)}`,
    name: task.name ?? "task",
    source: task.source ?? source,
    type: task.definition?.type ?? "shell",
    command: typeof exec.commandLine === "string" ? exec.commandLine : exec.command,
    args: exec.args,
    cwd: exec.options?.cwd,
  };
}

export class ExtHostTask implements ExtHostTaskShape {
  private readonly proxy: MainThreadTaskShape;
  private readonly providers = new Map<number, { type: string; provider: TaskProvider }>();
  private seq = 0;
  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadTask);
  }
  registerTaskProvider(type: string, provider: TaskProvider): Disposable {
    const handle = this.seq++;
    this.providers.set(handle, { type, provider });
    this.proxy.$registerTaskProvider(handle, type);
    return new Disposable(() => {
      this.providers.delete(handle);
      this.proxy.$unregisterTaskProvider(handle);
    });
  }
  async executeTask(task: unknown): Promise<{ task: unknown }> {
    await this.proxy.$executeTask(toTaskDto(task, "extension"));
    return { task };
  }
  async $provideTasks(handle: number): Promise<dto.TaskDto[]> {
    const entry = this.providers.get(handle);
    if (!entry) return [];
    const tasks = (await entry.provider.provideTasks()) ?? [];
    return tasks.map((t) => toTaskDto(t, entry.type));
  }
}
