// In-process loopback smoke test: wires a "renderer" RPCProtocol to a "host"
// RPCProtocol via paired in-memory transports, registers minimal MainThread
// stubs, loads the sample extension, and exercises commands + language features.
// Run with: npm run smoke

import * as path from "path";
import { ITransport, RpcMessage, RPCProtocol } from "./common/rpcProtocol";
import {
  ExtHostContext,
  MainContext,
  MainThreadCommandsShape,
  MainThreadLanguageFeaturesShape,
  MainThreadMessageServiceShape,
} from "./common/protocol";
import { Services } from "./host/services";
import { ExtHostExtensionService, readExtensionDescription } from "./host/extensionService";

function pairedTransports(): [ITransport, ITransport] {
  let aHandler: ((m: RpcMessage) => void) | undefined;
  let bHandler: ((m: RpcMessage) => void) | undefined;
  const a: ITransport = {
    send: (m) => queueMicrotask(() => bHandler?.(m)),
    onMessage: (h) => (aHandler = h),
  };
  const b: ITransport = {
    send: (m) => queueMicrotask(() => aHandler?.(m)),
    onMessage: (h) => (bHandler = h),
  };
  return [a, b];
}

async function run(): Promise<void> {
  const [mainTransport, hostTransport] = pairedTransports();
  const mainRpc = new RPCProtocol(mainTransport);
  const hostRpc = new RPCProtocol(hostTransport);

  // ── Host side ──
  const services = new Services(hostRpc);
  const extensionService = new ExtHostExtensionService(services, (m) => console.error(m));
  hostRpc.set(ExtHostContext.ExtHostExtensionService, extensionService);

  // ── Main (renderer) side stubs ──
  const registered: string[] = [];
  const completionHandles = new Map<number, string[]>();
  const messages: string[] = [];

  const mainCommands: MainThreadCommandsShape = {
    $registerCommand: (id) => registered.push(id),
    $unregisterCommand: () => undefined,
    $executeCommand: async () => undefined,
  };
  const mainLang: MainThreadLanguageFeaturesShape = {
    $registerCompletionSupport: (handle, selector) => completionHandles.set(handle, selector),
    $registerHoverProvider: () => undefined,
    $registerDefinitionProvider: () => undefined,
    $registerReferenceProvider: () => undefined,
    $registerDocumentHighlightProvider: () => undefined,
    $registerDocumentSymbolProvider: () => undefined,
    $registerFormattingProvider: () => undefined,
    $registerCodeActionProvider: () => undefined,
    $registerSignatureHelpProvider: () => undefined,
    $unregister: () => undefined,
  };
  const mainMessage: MainThreadMessageServiceShape = {
    $showMessage: async (_sev, message) => {
      messages.push(message);
      return undefined;
    },
  };
  // Stubs for everything first so incidental calls resolve...
  for (const id of Object.values(MainContext)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mainRpc.set(id as any, new Proxy({}, { get: () => () => undefined }) as any);
  }
  // ...then override the ones this test asserts on.
  mainRpc.set(MainContext.MainThreadCommands, mainCommands);
  mainRpc.set(MainContext.MainThreadLanguageFeatures, mainLang);
  mainRpc.set(MainContext.MainThreadMessageService, mainMessage);

  // ── Drive the lifecycle from the renderer's proxies ──
  const extHost = mainRpc.getProxy(ExtHostContext.ExtHostExtensionService);
  const langExt = mainRpc.getProxy(ExtHostContext.ExtHostLanguageFeatures);
  const cmdExt = mainRpc.getProxy(ExtHostContext.ExtHostCommands);
  const docExt = mainRpc.getProxy(ExtHostContext.ExtHostDocuments);

  const sampleDir = path.join(__dirname, "..", "sample-extension");
  const desc = readExtensionDescription(sampleDir);
  if (!desc) throw new Error("sample extension not found at " + sampleDir);

  await extHost.$initialize({ workspaceFolders: [], configuration: {}, extensions: [desc] });

  // Open a JS document so language features have something to read.
  const uri = { scheme: "file", path: "/tmp/test.js" };
  docExt.$acceptModelOpened({ uri, languageId: "javascript", versionId: 1, lines: ["const x = 1;"], eol: "\n" });

  // 1. command registration
  assert(registered.includes("agentzSample.hello"), "command registered");

  // 2. execute the contributed command
  const result = await cmdExt.$executeContributedCommand("agentzSample.hello", ["AgentZ"]);
  assert(result === "hello:AgentZ:1", `command result: ${String(result)}`);
  assert(messages.length === 1 && messages[0].includes("Hello, AgentZ"), "message shown");

  // 3. completion registered for javascript
  const handle = [...completionHandles.entries()].find(([, sel]) => sel.includes("javascript"))?.[0];
  assert(handle !== undefined, "completion provider registered for javascript");

  // 4. completion invocation round-trips a real item
  const completions = await langExt.$provideCompletionItems(handle as number, uri, { line: 0, character: 6 }, ".");
  assert(!!completions && completions.items.length === 1, "completion returned 1 item");
  assert(completions!.items[0].label === "agentzHello", "completion label");
  assert(completions!.items[0].insertTextIsSnippet === true, "completion is snippet");

  console.log("\nSMOKE OK — all assertions passed");
  console.log(`  commands: ${registered.join(", ")}`);
  console.log(`  messages: ${messages.join(" | ")}`);
  console.log(`  completion: ${completions!.items[0].label} -> ${completions!.items[0].insertText}`);
}

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

run()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error("SMOKE ERROR:", err);
    process.exit(1);
  });
