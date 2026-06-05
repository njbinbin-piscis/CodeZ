// ExtHostTesting: backs vscode.tests.createTestController. Test trees are
// published to the renderer's Test Explorer; runs are requested via $runTests.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostTestingShape, MainContext, MainThreadTestingShape } from "../common/protocol";
import { Disposable, Range, Uri } from "./types-impl";

class TestItem {
  children = new Map<string, TestItem>();
  range?: Range;
  constructor(public id: string, public label: string, public uri?: Uri) {}
  get childCollection() {
    const self = this;
    return {
      add: (item: TestItem) => self.children.set(item.id, item),
      delete: (id: string) => self.children.delete(id),
      get: (id: string) => self.children.get(id),
      replace: (items: TestItem[]) => {
        self.children.clear();
        for (const i of items) self.children.set(i.id, i);
      },
      forEach: (cb: (item: TestItem) => void) => self.children.forEach(cb),
      get size() {
        return self.children.size;
      },
    };
  }
}

function toDto(item: TestItem, parentId?: string): dto.TestItemDto {
  return {
    id: item.id,
    label: item.label,
    uri: item.uri?.toJSON(),
    range: item.range
      ? { startLine: item.range.start.line, startCharacter: item.range.start.character, endLine: item.range.end.line, endCharacter: item.range.end.character }
      : undefined,
    parentId,
    children: [...item.children.values()].map((c) => toDto(c, item.id)),
  };
}

class TestController {
  readonly items = new Map<string, TestItem>();
  private runHandlers: ((request: unknown) => void)[] = [];
  constructor(public readonly id: string, public label: string, private readonly publish: () => void) {}
  createTestItem(id: string, label: string, uri?: Uri): TestItem {
    return new TestItem(id, label, uri);
  }
  get itemsCollection() {
    const self = this;
    return {
      add: (item: TestItem) => {
        self.items.set(item.id, item);
        self.publish();
      },
      delete: (id: string) => {
        self.items.delete(id);
        self.publish();
      },
      replace: (items: TestItem[]) => {
        self.items.clear();
        for (const i of items) self.items.set(i.id, i);
        self.publish();
      },
      forEach: (cb: (item: TestItem) => void) => self.items.forEach(cb),
      get: (id: string) => self.items.get(id),
      get size() {
        return self.items.size;
      },
    };
  }
  createRunProfile(_label: string, _kind: number, runHandler: (request: unknown) => void): { dispose(): void } {
    this.runHandlers.push(runHandler);
    return { dispose: () => undefined };
  }
  run(request: unknown): void {
    for (const h of this.runHandlers) h(request);
  }
  snapshot(): dto.TestItemDto[] {
    return [...this.items.values()].map((i) => toDto(i));
  }
  dispose(): void {
    this.items.clear();
  }
}

export class ExtHostTesting implements ExtHostTestingShape {
  private readonly proxy: MainThreadTestingShape;
  private readonly controllers = new Map<string, TestController>();
  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadTesting);
  }
  createTestController(id: string, label: string): TestController {
    const controller = new TestController(id, label, () => this.proxy.$publishTestItems(id, controller.snapshot()));
    this.controllers.set(id, controller);
    this.proxy.$registerTestController(id, label);
    return controller;
  }
  async $runTests(controllerId: string, testIds: string[]): Promise<void> {
    const controller = this.controllers.get(controllerId);
    if (!controller) return;
    controller.run({ include: testIds, exclude: [] });
  }
  static disposable(): Disposable {
    return new Disposable(() => undefined);
  }
}
