// ExtHostScm: backs vscode.scm.createSourceControl. Resource groups are pushed
// to the renderer's SCM view; enables SCM-provider extensions (e.g. GitLens).

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { MainContext, MainThreadScmShape } from "../common/protocol";
import { Disposable, Uri } from "./types-impl";

class SourceControlResourceGroup {
  private _resources: { resourceUri: Uri; decorations?: { tooltip?: string; strikeThrough?: boolean; faded?: boolean } }[] = [];
  hideWhenEmpty = false;
  constructor(public readonly id: string, public label: string, private readonly onChange: () => void) {}
  get resourceStates() {
    return this._resources;
  }
  set resourceStates(states: { resourceUri: Uri; decorations?: { tooltip?: string; strikeThrough?: boolean; faded?: boolean } }[]) {
    this._resources = states;
    this.onChange();
  }
  dispose(): void {
    this._resources = [];
    this.onChange();
  }
}

class SourceControl {
  private groups: SourceControlResourceGroup[] = [];
  count = 0;
  inputBox = { value: "", placeholder: "" };
  quickDiffProvider?: unknown;
  commitTemplate?: string;
  constructor(
    public readonly handle: number,
    public readonly id: string,
    public readonly label: string,
    public readonly rootUri: Uri | undefined,
    private readonly proxy: MainThreadScmShape,
  ) {}
  createResourceGroup(id: string, label: string): SourceControlResourceGroup {
    const group = new SourceControlResourceGroup(id, label, () => this.flush());
    this.groups.push(group);
    this.flush();
    return group;
  }
  private flush(): void {
    const groups: dto.ScmGroupDto[] = this.groups
      .filter((g) => !g.hideWhenEmpty || g.resourceStates.length > 0)
      .map((g, gi) => ({
        handle: gi,
        id: g.id,
        label: g.label,
        hideWhenEmpty: g.hideWhenEmpty,
        resources: g.resourceStates.map((r, ri) => ({
          handle: ri,
          resourceUri: r.resourceUri.toJSON(),
          tooltip: r.decorations?.tooltip,
          strikeThrough: r.decorations?.strikeThrough,
          faded: r.decorations?.faded,
        })),
      }));
    this.proxy.$updateGroups(this.handle, groups);
  }
  dispose(): void {
    this.proxy.$unregisterSourceControl(this.handle);
  }
}

export class ExtHostScm {
  private readonly proxy: MainThreadScmShape;
  private seq = 0;
  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadScm);
  }
  createSourceControl(id: string, label: string, rootUri?: Uri): SourceControl {
    const handle = this.seq++;
    this.proxy.$registerSourceControl(handle, id, label, rootUri?.toJSON());
    return new SourceControl(handle, id, label, rootUri, this.proxy);
  }
  static disposable(): Disposable {
    return new Disposable(() => undefined);
  }
}
