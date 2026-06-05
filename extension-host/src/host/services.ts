// Instantiates every ExtHost* actor and registers it on the RPC protocol so the
// renderer's MainThread* side can call back into the host.

import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostContext } from "../common/protocol";
import { ExtHostCommands } from "./extHostCommands";
import { ExtHostDocuments } from "./extHostDocuments";
import { ExtHostLanguageFeatures } from "./extHostLanguageFeatures";
import { ExtHostWorkspace } from "./extHostWorkspace";
import { ExtHostWindow } from "./extHostWindow";
import { ExtHostTreeViews } from "./extHostTreeViews";
import { ExtHostWebviews } from "./extHostWebviews";
import { ExtHostScm } from "./extHostScm";
import { ExtHostTask } from "./extHostTasks";
import { ExtHostDebug } from "./extHostDebug";
import { ExtHostTesting } from "./extHostTesting";
import { ExtHostNotebook } from "./extHostNotebook";

export class Services {
  readonly commands: ExtHostCommands;
  readonly documents: ExtHostDocuments;
  readonly languageFeatures: ExtHostLanguageFeatures;
  readonly workspace: ExtHostWorkspace;
  readonly window: ExtHostWindow;
  readonly treeViews: ExtHostTreeViews;
  readonly webviews: ExtHostWebviews;
  readonly scm: ExtHostScm;
  readonly tasks: ExtHostTask;
  readonly debug: ExtHostDebug;
  readonly testing: ExtHostTesting;
  readonly notebook: ExtHostNotebook;

  constructor(rpc: IRPCProtocol) {
    this.commands = new ExtHostCommands(rpc);
    this.documents = new ExtHostDocuments();
    this.workspace = new ExtHostWorkspace(rpc);
    this.languageFeatures = new ExtHostLanguageFeatures(rpc, this.documents, this.commands);
    this.window = new ExtHostWindow(rpc);
    this.treeViews = new ExtHostTreeViews(rpc);
    this.webviews = new ExtHostWebviews(rpc);
    this.scm = new ExtHostScm(rpc);
    this.tasks = new ExtHostTask(rpc);
    this.debug = new ExtHostDebug(rpc);
    this.testing = new ExtHostTesting(rpc);
    this.notebook = new ExtHostNotebook(rpc);

    rpc.set(ExtHostContext.ExtHostCommands, this.commands);
    rpc.set(ExtHostContext.ExtHostLanguageFeatures, this.languageFeatures);
    rpc.set(ExtHostContext.ExtHostDocuments, this.documents);
    rpc.set(ExtHostContext.ExtHostConfiguration, this.workspace);
    rpc.set(ExtHostContext.ExtHostWorkspace, this.workspace);
    rpc.set(ExtHostContext.ExtHostTreeViews, this.treeViews);
    rpc.set(ExtHostContext.ExtHostWebviews, this.webviews);
    rpc.set(ExtHostContext.ExtHostTask, this.tasks);
    rpc.set(ExtHostContext.ExtHostDebug, this.debug);
    rpc.set(ExtHostContext.ExtHostTesting, this.testing);
    rpc.set(ExtHostContext.ExtHostNotebook, this.notebook);
  }
}
