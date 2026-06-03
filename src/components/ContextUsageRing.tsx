import { useTranslation } from "react-i18next";

/** Snapshot mirroring the kernel's `AgentEvent::ContextUsage` payload. */
export interface ContextUsageSnapshot {
  estimatedInputTokens: number;
  totalInputBudget: number;
  triggerThreshold: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  rollingSummaryVersion: number;
  autoCompactThreshold: number;
}

function formatTokens(value: number | null | undefined): string {
  if (!value || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Compact ring indicator showing how full the context window is relative to the
 * proactive-compaction trigger threshold (mirrors openpiscis). Hidden until the
 * first `ContextUsage` event arrives.
 */
export default function ContextUsageRing({ usage }: { usage: ContextUsageSnapshot | null }) {
  const { t } = useTranslation();
  if (!usage || usage.triggerThreshold <= 0) return null;

  const pct = Math.min(100, (usage.estimatedInputTokens / usage.triggerThreshold) * 100);
  const budgetPct =
    usage.totalInputBudget > 0
      ? Math.round((usage.estimatedInputTokens / usage.totalInputBudget) * 100)
      : 0;

  let color = "var(--accent, #6c63ff)";
  if (pct >= 100) color = "var(--danger, #e5484d)";
  else if (pct >= 80) color = "var(--warning, #f5a623)";

  const r = 7;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;

  const tooltip = [
    t("chat.contextRingTitle"),
    t("chat.contextRingEstimate", {
      estimated: formatTokens(usage.estimatedInputTokens),
      trigger: formatTokens(usage.triggerThreshold),
      budget: formatTokens(usage.totalInputBudget),
    }),
    t("chat.contextRingCumulative", {
      input: formatTokens(usage.cumulativeInputTokens),
      output: formatTokens(usage.cumulativeOutputTokens),
    }),
  ].join("\n");

  return (
    <span className="codez-context-ring" title={tooltip} aria-label={tooltip}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border, #333)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="codez-context-ring-label">{budgetPct}%</span>
    </span>
  );
}
