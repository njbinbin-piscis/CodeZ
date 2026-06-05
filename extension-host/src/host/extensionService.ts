// ExtHostExtensionService: scans installed extensions, intercepts
// require('vscode') to inject our API, and activates extensions by event.

import * as fs from "fs";
import * as path from "path";
import Module from "module";

import { ExtensionDescriptionDto } from "../common/dto";
import {
  CompatReportDto,
  ExtensionCompatDto,
  ExtHostExtensionServiceShape,
  HOST_VSCODE_VERSION,
  InitDataDto,
} from "../common/protocol";
import { Services } from "./services";
import { createApiFactory, ExtensionContext, Memento } from "./apiFactory";
import { Uri } from "./types-impl";
import { satisfies } from "./semver";

// Proposed API names this host actually implements. Anything an extension
// declares in `enabledApiProposals` outside this set is reported as unsupported.
const SUPPORTED_PROPOSALS = new Set<string>();

interface ActivatedExtension {
  description: ExtensionDescriptionDto;
  module?: { activate?: (ctx: ExtensionContext) => unknown; deactivate?: () => unknown };
  exports?: unknown;
  context: ExtensionContext;
}

export class ExtHostExtensionService implements ExtHostExtensionServiceShape {
  private readonly apiFactory: ReturnType<typeof createApiFactory>;
  private readonly registry = new Map<string, ExtensionDescriptionDto>();
  private readonly activated = new Map<string, Promise<ActivatedExtension>>();
  private readonly compat = new Map<string, ExtensionCompatDto>();
  private readonly logger: (msg: string) => void;

  constructor(private readonly services: Services, logger: (msg: string) => void) {
    this.apiFactory = createApiFactory(services);
    this.logger = logger;
    this.patchRequire();
  }

  register(descriptions: ExtensionDescriptionDto[]): void {
    for (const d of descriptions) {
      this.registry.set(d.id, d);
    }
  }

  private apiForExtension(description: ExtensionDescriptionDto): Record<string, unknown> {
    return this.apiFactory(description);
  }

  /** Evaluate engines.vscode + enabledApiProposals against this host. */
  private checkCompat(d: ExtensionDescriptionDto): ExtensionCompatDto {
    const enginesVscode = d.engines?.vscode;
    let compatible = true;
    let reason: string | undefined;
    if (enginesVscode && enginesVscode !== "*") {
      if (!satisfies(HOST_VSCODE_VERSION, enginesVscode)) {
        compatible = false;
        reason = `requires VS Code ${enginesVscode}, host implements ${HOST_VSCODE_VERSION}`;
      }
    }
    const unsupported = (d.enabledApiProposals ?? []).filter((p) => !SUPPORTED_PROPOSALS.has(p));
    return {
      id: d.id,
      displayName: d.displayName,
      version: d.version,
      enginesVscode,
      compatible,
      reason,
      unsupportedProposals: unsupported.length ? unsupported : undefined,
      activated: false,
    };
  }

  // Make require('vscode') resolve to our API object for the extension whose
  // code is currently executing (tracked via the loaded module path).
  private patchRequire(): void {
    const self = this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalLoad = (Module as any)._load;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
      if (request === "vscode") {
        const description = self.findOwningExtension(parent?.filename);
        return self.apiForExtension(description ?? self.fallbackDescription());
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  }

  private findOwningExtension(filename?: string): ExtensionDescriptionDto | undefined {
    if (!filename) return undefined;
    let best: ExtensionDescriptionDto | undefined;
    for (const d of this.registry.values()) {
      if (filename.startsWith(d.extensionPath) && (!best || d.extensionPath.length > best.extensionPath.length)) {
        best = d;
      }
    }
    return best;
  }

  private fallbackDescription(): ExtensionDescriptionDto {
    return { id: "unknown", name: "unknown", publisher: "unknown", version: "0.0.0", extensionPath: "", activationEvents: [] };
  }

  private makeContext(description: ExtensionDescriptionDto): ExtensionContext {
    const extensionUri = Uri.file(description.extensionPath);
    const subscriptions: { dispose(): unknown }[] = [];
    return {
      subscriptions,
      extensionPath: description.extensionPath,
      extensionUri,
      globalState: new Memento(),
      workspaceState: new Memento(),
      asAbsolutePath: (relative: string) => path.join(description.extensionPath, relative),
      globalStorageUri: Uri.file(path.join(description.extensionPath, ".globalStorage")),
      logUri: Uri.file(path.join(description.extensionPath, ".log")),
      extensionMode: 1,
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
    };
  }

  activate(id: string): Promise<ActivatedExtension> {
    const existing = this.activated.get(id);
    if (existing) return existing;

    const description = this.registry.get(id);
    if (!description) return Promise.reject(new Error(`extension not registered: ${id}`));

    const compat = this.compat.get(id);
    if (compat && !compat.compatible) {
      this.logger(`[ext] skipping incompatible ${id}: ${compat.reason}`);
      return Promise.reject(new Error(`incompatible: ${compat.reason}`));
    }
    if (compat?.unsupportedProposals) {
      this.logger(`[ext] ${id} uses unsupported proposed API: ${compat.unsupportedProposals.join(", ")}`);
    }

    const promise = (async (): Promise<ActivatedExtension> => {
      const context = this.makeContext(description);
      const activated: ActivatedExtension = { description, context };
      if (!description.main) {
        this.logger(`[ext] ${id} has no main; declarative-only`);
        const c = this.compat.get(id);
        if (c) c.activated = true;
        return activated;
      }
      const mainPath = path.isAbsolute(description.main) ? description.main : path.join(description.extensionPath, description.main);
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(mainPath);
        activated.module = mod;
        if (typeof mod.activate === "function") {
          this.logger(`[ext] activating ${id}`);
          activated.exports = await mod.activate(context);
        }
        const c = this.compat.get(id);
        if (c) c.activated = true;
      } catch (err) {
        this.logger(`[ext] activation failed for ${id}: ${err instanceof Error ? err.stack : String(err)}`);
        throw err;
      }
      return activated;
    })();

    this.activated.set(id, promise);
    return promise;
  }

  async $initialize(data: InitDataDto): Promise<CompatReportDto> {
    this.services.workspace.initialize(data.workspaceFolders, data.configuration);
    const all = [...data.extensions];
    if (data.extensionsDir) {
      for (const desc of scanExtensions(data.extensionsDir)) {
        if (!all.some((d) => d.id === desc.id)) all.push(desc);
      }
    }
    this.register(all);
    for (const d of all) this.compat.set(d.id, this.checkCompat(d));
    const incompatible = [...this.compat.values()].filter((c) => !c.compatible);
    this.logger(
      `[ext] initialized with ${all.length} extension(s); ${incompatible.length} incompatible`,
    );
    await this.activateStartup();
    return { hostVersion: HOST_VSCODE_VERSION, extensions: [...this.compat.values()] };
  }

  async $activateExtension(id: string): Promise<void> {
    await this.activate(id);
  }

  async $activateByEvent(event: string): Promise<void> {
    const toActivate: string[] = [];
    for (const [id, d] of this.registry) {
      if (this.activated.has(id)) continue;
      if (d.activationEvents.includes("*") || d.activationEvents.includes(event) || matchesEvent(d.activationEvents, event)) {
        toActivate.push(id);
      }
    }
    await Promise.all(
      toActivate.map((id) =>
        this.activate(id).catch((err) => this.logger(`[ext] ${id} failed: ${String(err)}`)),
      ),
    );
  }

  // Synchronously activate everything that requests "*" or onStartupFinished.
  async activateStartup(): Promise<void> {
    await this.$activateByEvent("*");
    await this.$activateByEvent("onStartupFinished");
  }
}

function matchesEvent(activationEvents: string[], event: string): boolean {
  // Support prefix matching like onLanguage:python matching onLanguage:python.
  for (const e of activationEvents) {
    if (e === event) return true;
    // onCommand:foo, onLanguage:bar — exact already handled; allow onLanguage
    // wildcard via "onLanguage" matching any onLanguage:* event.
    if (e.endsWith(":*") && event.startsWith(e.slice(0, -1))) return true;
  }
  return false;
}

/** Read an extension folder's package.json into a description DTO. */
export function readExtensionDescription(dir: string): ExtensionDescriptionDto | undefined {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const publisher = pkg.publisher ?? "unknown";
    const name = pkg.name ?? path.basename(dir);
    return {
      id: `${publisher}.${name}`,
      name,
      publisher,
      version: pkg.version ?? "0.0.0",
      displayName: pkg.displayName,
      main: pkg.main,
      extensionPath: dir,
      activationEvents: pkg.activationEvents ?? (pkg.main ? ["*"] : []),
      contributes: pkg.contributes,
      engines: pkg.engines,
      enabledApiProposals: pkg.enabledApiProposals,
    };
  } catch {
    return undefined;
  }
}

/** Scan a directory of unpacked extensions (each in its own subfolder). */
export function scanExtensions(extensionsDir: string): ExtensionDescriptionDto[] {
  if (!fs.existsSync(extensionsDir)) return [];
  const out: ExtensionDescriptionDto[] = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(extensionsDir, entry.name);
    // VS Code .vsix unpack to an `extension/` subdir; support both layouts.
    const inner = path.join(dir, "extension");
    const target = fs.existsSync(path.join(inner, "package.json")) ? inner : dir;
    const desc = readExtensionDescription(target);
    if (desc) out.push(desc);
  }
  return out;
}
