/** Relative artifact path → absolute file path inside the active workspace. */
export function resolveArtifactFullPath(
  projectDir: string,
  relativePath: string,
  workspaceDir?: string | null,
): string {
  const root = (workspaceDir?.trim() || projectDir).replace(/[/\\]+$/, "");
  const rel = relativePath.replace(/^[/\\]+/, "");
  return `${root}/${rel}`;
}

export interface ArtifactNode {
  name: string;
  /** Project-relative path used as the artifact key. */
  path: string;
  isDir: boolean;
  children?: ArtifactNode[];
}

/** Turn a flat path list into a folder tree for the artifacts drawer. */
export function buildArtifactTree(paths: string[]): ArtifactNode[] {
  const root: ArtifactNode[] = [];
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));

  for (const full of sorted) {
    const parts = full.split("/").filter(Boolean);
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      const isDir = i < parts.length - 1;
      let node = level.find((n) => n.name === part);
      if (!node) {
        node = { name: part, path: acc, isDir, children: isDir ? [] : undefined };
        level.push(node);
        level.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
      if (isDir) {
        if (!node.children) node.children = [];
        level = node.children;
      }
    }
  }
  return root;
}

export function isPdfPath(name: string): boolean {
  return /\.pdf$/i.test(name);
}
