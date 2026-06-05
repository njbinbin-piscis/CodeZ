// ExtHostNotebook: backs vscode.workspace.registerNotebookSerializer. The
// renderer asks the host to (de)serialize notebook content for its editor.

import * as dto from "../common/dto";
import { IRPCProtocol } from "../common/proxyIdentifier";
import { ExtHostNotebookShape, MainContext, MainThreadNotebookShape } from "../common/protocol";
import { Disposable, Uri } from "./types-impl";

interface NotebookSerializer {
  deserializeNotebook(content: Uint8Array): { cells: { kind: number; value: string; languageId: string }[] } | Thenable<{ cells: { kind: number; value: string; languageId: string }[] }>;
  serializeNotebook(data: { cells: { kind: number; value: string; languageId: string }[] }): Uint8Array | Thenable<Uint8Array>;
}

export class ExtHostNotebook implements ExtHostNotebookShape {
  private readonly proxy: MainThreadNotebookShape;
  private readonly serializers = new Map<string, NotebookSerializer>();
  constructor(rpc: IRPCProtocol) {
    this.proxy = rpc.getProxy(MainContext.MainThreadNotebook);
  }
  registerNotebookSerializer(viewType: string, serializer: NotebookSerializer): Disposable {
    this.serializers.set(viewType, serializer);
    this.proxy.$registerNotebookSerializer(viewType);
    return new Disposable(() => {
      this.serializers.delete(viewType);
      this.proxy.$unregisterNotebookSerializer(viewType);
    });
  }
  async $deserializeNotebook(viewType: string, content: string): Promise<dto.NotebookDocumentDto> {
    const serializer = this.serializers.get(viewType);
    const empty: dto.NotebookDocumentDto = { uri: Uri.parse("untitled:notebook").toJSON(), notebookType: viewType, cells: [] };
    if (!serializer) return empty;
    const data = await serializer.deserializeNotebook(new TextEncoder().encode(content));
    return {
      uri: Uri.parse("untitled:notebook").toJSON(),
      notebookType: viewType,
      cells: data.cells.map((c, i) => ({ handle: i, kind: c.kind, language: c.languageId, source: c.value })),
    };
  }
  async $serializeNotebook(viewType: string, doc: dto.NotebookDocumentDto): Promise<string> {
    const serializer = this.serializers.get(viewType);
    if (!serializer) return "";
    const bytes = await serializer.serializeNotebook({
      cells: doc.cells.map((c) => ({ kind: c.kind, value: c.source, languageId: c.language })),
    });
    return new TextDecoder().decode(bytes);
  }
}
