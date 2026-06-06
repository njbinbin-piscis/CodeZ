import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";

export interface WfNodeData {
  glyph: string;
  color: string;
  title: string;
  sub?: string;
  kind: string;
}

function WfNode({ data, selected }: NodeProps<WfNodeData>) {
  const isStart = data.kind === "start";
  const isEnd = data.kind === "end";

  return (
    <div className={`wf-node-card ${selected ? "selected" : ""} wf-kind-${data.kind}`}>
      {!isStart && (
        <>
          <Handle type="target" position={Position.Left} id="left" className="wf-handle wf-handle-in" />
          <Handle type="target" position={Position.Right} id="right-in" className="wf-handle wf-handle-right-in" />
          <Handle type="target" position={Position.Top} id="top" className="wf-handle wf-handle-top-in" />
          <Handle
            type="target"
            position={Position.Bottom}
            id="bottom-in"
            className="wf-handle wf-handle-bottom-in"
          />
        </>
      )}
      {!isEnd && (
        <>
          <Handle type="source" position={Position.Right} id="right" className="wf-handle wf-handle-out" />
          <Handle
            type="source"
            position={Position.Bottom}
            id="bottom"
            className="wf-handle wf-handle-bottom"
          />
          <Handle type="source" position={Position.Top} id="top-out" className="wf-handle wf-handle-top-out" />
          <Handle type="source" position={Position.Left} id="left-out" className="wf-handle wf-handle-left-out" />
        </>
      )}
      <div className="wf-node-inner">
        <span className="wf-node-badge" style={{ background: data.color }}>
          {data.glyph}
        </span>
        <div className="wf-node-text">
          <span className="wf-node-title">{data.title}</span>
          {data.sub && <span className="wf-node-sub">{data.sub}</span>}
        </div>
      </div>
    </div>
  );
}

export default memo(WfNode);
