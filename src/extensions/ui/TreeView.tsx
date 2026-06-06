import { useEffect, useState, useCallback } from "react";
import type { TreeItemDto } from "../common/dto";
import { extensionService } from "../extensionService";

interface NodeProps {
  viewId: string;
  item: TreeItemDto;
  depth: number;
}

function TreeNode({ viewId, item, depth }: NodeProps) {
  const [expanded, setExpanded] = useState(item.collapsibleState === 2);
  const [children, setChildren] = useState<TreeItemDto[] | null>(null);
  const collapsible = item.collapsibleState !== 0;

  const loadChildren = useCallback(async () => {
    const kids = await extensionService.getTreeChildren(viewId, item.handle);
    setChildren(kids as TreeItemDto[]);
  }, [viewId, item.handle]);

  useEffect(() => {
    if (expanded && children === null && collapsible) void loadChildren();
  }, [expanded, children, collapsible, loadChildren]);

  return (
    <div className="agentz-tree-node">
      <div
        className="agentz-tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (collapsible) setExpanded((v) => !v);
          if (item.command) void extensionService.executeCommand(item.command.id, ...(item.command.arguments ?? []));
        }}
      >
        <span className="agentz-tree-twist">{collapsible ? (expanded ? "▾" : "▸") : ""}</span>
        {item.iconId && <span className="agentz-tree-icon">$({item.iconId})</span>}
        <span className="agentz-tree-label">{item.label}</span>
        {item.description && <span className="agentz-tree-desc">{item.description}</span>}
      </div>
      {expanded && children && children.map((c) => <TreeNode key={c.handle} viewId={viewId} item={c} depth={depth + 1} />)}
    </div>
  );
}

interface TreeViewProps {
  viewId: string;
  roots: TreeItemDto[];
  version: number;
}

/** Renders a contributed vscode.TreeView, pulling children lazily over RPC. */
export default function TreeView({ viewId, roots, version }: TreeViewProps) {
  const [rootItems, setRootItems] = useState<TreeItemDto[]>(roots);

  useEffect(() => {
    if (roots.length > 0) {
      setRootItems(roots);
      return;
    }
    // No pushed roots yet — pull them.
    void extensionService.getTreeChildren(viewId).then((kids) => setRootItems(kids as TreeItemDto[]));
  }, [viewId, roots, version]);

  if (rootItems.length === 0) return <div className="agentz-tree-empty">No items</div>;
  return (
    <div className="agentz-tree">
      {rootItems.map((item) => (
        <TreeNode key={item.handle} viewId={viewId} item={item} depth={0} />
      ))}
    </div>
  );
}
