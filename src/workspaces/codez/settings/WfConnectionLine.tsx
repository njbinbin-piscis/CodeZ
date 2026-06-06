import { getSmoothStepPath, type ConnectionLineComponentProps } from "reactflow";

export default function WfConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps) {
  const valid = connectionStatus === "valid";
  const [path] = getSmoothStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    borderRadius: 8,
  });

  return (
    <g className="wf-connection-preview">
      <path
        fill="none"
        stroke={valid ? "#4ecdc4" : "#6b6b80"}
        strokeWidth={valid ? 3 : 1.5}
        strokeDasharray={valid ? undefined : "6 4"}
        d={path}
      />
      {valid && (
        <circle cx={toX} cy={toY} r={6} fill="#4ecdc4" fillOpacity={0.35} stroke="#4ecdc4" strokeWidth={2} />
      )}
    </g>
  );
}
