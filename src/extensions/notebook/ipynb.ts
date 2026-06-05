// Minimal built-in .ipynb (Jupyter) parse/serialize so notebooks render even
// without a notebook extension installed. When an extension registers a
// serializer for the notebook type, the renderer prefers that instead.

export interface NbCell {
  id: string;
  kind: 1 | 2; // 1 = markup, 2 = code
  language: string;
  source: string;
  outputs?: string[];
}

interface IpynbOutput {
  text?: string | string[];
  data?: Record<string, unknown>;
}

interface IpynbCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: IpynbOutput[];
}

interface IpynbRaw {
  cells?: IpynbCell[];
  metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } };
  nbformat?: number;
  nbformat_minor?: number;
}

let cellSeq = 0;
const nextId = () => `cell-${Date.now()}-${cellSeq++}`;

function joinSource(src: string | string[] | undefined): string {
  if (Array.isArray(src)) return src.join("");
  return src ?? "";
}

function outputText(outputs: IpynbOutput[] | undefined): string[] {
  if (!outputs) return [];
  const lines: string[] = [];
  for (const o of outputs) {
    if (o.text) lines.push(joinSource(o.text));
    const data = o.data as Record<string, unknown> | undefined;
    const plain = data?.["text/plain"];
    if (plain) lines.push(joinSource(plain as string | string[]));
  }
  return lines.filter(Boolean);
}

export function parseIpynb(content: string): { cells: NbCell[]; language: string } {
  let raw: IpynbRaw;
  try {
    raw = JSON.parse(content) as IpynbRaw;
  } catch {
    return { cells: [], language: "python" };
  }
  const language = raw.metadata?.language_info?.name ?? raw.metadata?.kernelspec?.language ?? "python";
  const cells: NbCell[] = (raw.cells ?? []).map((c) => ({
    id: nextId(),
    kind: c.cell_type === "markdown" ? 1 : 2,
    language: c.cell_type === "markdown" ? "markdown" : language,
    source: joinSource(c.source),
    outputs: outputText(c.outputs),
  }));
  return { cells, language };
}

/** Serialize cells back to a pretty-printed .ipynb document. */
export function serializeIpynb(cells: NbCell[], language = "python"): string {
  const doc = {
    cells: cells.map((c) => ({
      cell_type: c.kind === 1 ? "markdown" : "code",
      metadata: {},
      source: splitLines(c.source),
      ...(c.kind === 2 ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: {
      language_info: { name: language },
      kernelspec: { name: language, display_name: language, language },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(doc, null, 1);
}

/** Keep trailing newlines per nbformat convention (array of lines with \n). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  return parts.map((line, i) => (i < parts.length - 1 ? line + "\n" : line)).filter((_, i) => i < parts.length - 1 || parts[parts.length - 1] !== "");
}

export function emptyCell(kind: 1 | 2, language = "python"): NbCell {
  return { id: nextId(), kind, language: kind === 1 ? "markdown" : language, source: "" };
}
