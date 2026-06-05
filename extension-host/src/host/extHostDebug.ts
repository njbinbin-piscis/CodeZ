// ExtHostDebug: backs vscode.debug.*. Configuration providers resolve launch
// configs; the renderer drives the Debug Adapter Protocol session via Tauri.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostDebugShape, MainContext, MainThreadDebugShape } from "../common/protocol";
import { Disposable, EventEmitter } from "./types-impl";

interface DebugConfigurationProvider {
  resolveDebugConfiguration?(folder: unknown, config: dto.DebugConfigurationDto): dto.DebugConfigurationDto | undefined | Thenable<dto.DebugConfigurationDto | undefined>;
  provideDebugConfigurations?(folder: unknown): dto.DebugConfigurationDto[] | Thenable<dto.DebugConfigurationDto[]>;
}

export class ExtHostDebug implements ExtHostDebugShape {
  private readonly proxy: MainThreadDebugShape;
  private readonly providers = new Map<string, DebugConfigurationProvider>();
  readonly onDidStartDebugSessionEmitter = new EventEmitter<unknown>();
  readonly onDidTerminateDebugSessionEmitter = new EventEmitter<unknown>();
  readonly onDidReceiveDebugSessionCustomEvent = new EventEmitter<unknown>();

  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadDebug);
  }

  registerDebugConfigurationProvider(type: string, provider: DebugConfigurationProvider): Disposable {
    this.providers.set(type, provider);
    this.proxy.$registerDebugConfigurationProvider(type);
    return new Disposable(() => this.providers.delete(type));
  }

  registerDebugAdapterDescriptorFactory(): Disposable {
    return new Disposable(() => undefined);
  }

  startDebugging(_folder: unknown, config: dto.DebugConfigurationDto): Promise<boolean> {
    return this.proxy.$startDebugging(config);
  }

  async $resolveDebugConfiguration(type: string, config: dto.DebugConfigurationDto): Promise<dto.DebugConfigurationDto | undefined> {
    const provider = this.providers.get(type);
    if (!provider?.resolveDebugConfiguration) return config;
    const resolved = await provider.resolveDebugConfiguration(undefined, config);
    return resolved ?? undefined;
  }
}
