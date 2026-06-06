import { useState } from "react";
import { useTranslation } from "react-i18next";
import { summarizeToolCounts, toolIcon, toolSummary } from "../../components/toolDisplay";
import type { AgentToolEvent } from "./agentArtifacts";
import "./AgentToolPanel.css";

interface AgentToolPanelProps {
  tools: AgentToolEvent[];
}

export default function AgentToolPanel({ tools }: AgentToolPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (tools.length === 0) return null;

  const running = tools.filter((t) => t.status === "running").length;
  const errors = tools.filter((t) => t.status === "error").length;
  const summary = summarizeToolCounts(tools);

  return (
    <div className={`agentz-workz-tools${open ? " open" : ""}`}>
      <button type="button" className="agentz-workz-tools-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="agentz-workz-tools-toggle-left">
          {running > 0 && <span className="agentz-workz-tools-spinner" aria-hidden />}
          <span>{t("agent.toolsLabel", { count: tools.length })}</span>
          {!open && <span className="agentz-workz-tools-summary">{summary}</span>}
        </span>
        <span className="agentz-workz-tools-meta">
          {errors > 0 && <span className="agentz-workz-tools-errors">{errors} err</span>}
          <span className="agentz-workz-tools-chevron">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <ul className="agentz-workz-tools-list">
          {tools.map((tool) => {
            const hint = tool.path || toolSummary(tool.name, tool.input) || tool.name;
            const expanded = expandedId === tool.id;
            return (
              <li key={tool.id} className={`agentz-workz-tool-row ${tool.status}`}>
                <button
                  type="button"
                  className="agentz-workz-tool-row-head"
                  onClick={() => setExpandedId(expanded ? null : tool.id)}
                >
                  <span className="agentz-workz-tool-icon">{toolIcon(tool.name)}</span>
                  <span className="agentz-workz-tool-name">{tool.name}</span>
                  <span className="agentz-workz-tool-hint" title={hint}>
                    {hint}
                  </span>
                  <span className="agentz-workz-tool-status">
                    {tool.status === "running" ? (
                      <span className="agentz-workz-tools-spinner sm" aria-hidden />
                    ) : tool.status === "error" ? (
                      "✕"
                    ) : (
                      "✓"
                    )}
                  </span>
                </button>
                {expanded && tool.result && (
                  <pre className="agentz-workz-tool-result">{tool.result.slice(0, 800)}</pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
