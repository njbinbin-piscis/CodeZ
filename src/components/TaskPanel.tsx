import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanTodoItem } from "../services/tauri/chat";
import { toolIcon, toolSummary } from "./toolDisplay";
import "./TaskPanel.css";

export interface ToolStep {
  id: string;
  name: string;
  input: unknown;
  completed: boolean;
  expanded: boolean;
  result?: string;
  isError?: boolean;
}

export function mergePlanItems(existing: PlanTodoItem[], updates: PlanTodoItem[]): PlanTodoItem[] {
  const merged = existing.slice();
  for (const update of updates) {
    const idx = merged.findIndex((item) => item.id === update.id);
    if (idx >= 0) merged[idx] = update;
    else merged.push(update);
  }
  return merged;
}

export function parsePlanFromToolInput(input: unknown): PlanTodoItem[] {
  if (!input || typeof input !== "object") return [];
  const raw = input as { todos?: unknown[] };
  if (!Array.isArray(raw.todos)) return [];
  return raw.todos
    .map((item) => {
      const row = item as { id?: string; content?: string; status?: string };
      return {
        id: row.id ?? "",
        content: row.content ?? "",
        status: row.status ?? "pending",
      };
    })
    .filter((item) => item.id && item.content);
}

function planStatusLabel(t: ReturnType<typeof useTranslation>["t"], status: string): string {
  switch (status) {
    case "pending":
      return t("chat.planPending");
    case "in_progress":
      return t("chat.planInProgress");
    case "completed":
      return t("chat.planCompleted");
    case "cancelled":
      return t("chat.planCancelled");
    default:
      return status;
  }
}

export function PlanPanel({ items }: { items: PlanTodoItem[] }) {
  const { t } = useTranslation();
  return (
    <div className="codez-plan-panel-inner">
      {items.map((item, index) => (
        <div key={item.id} className={`codez-plan-item plan-${item.status}`}>
          <div className="codez-plan-item-left">
            <span className="codez-plan-item-index">{index + 1}</span>
            <span className="codez-plan-item-content">{item.content}</span>
          </div>
          <div className="codez-plan-item-right">
            <span className="codez-plan-item-id">{item.id}</span>
            <span className={`codez-plan-item-status plan-status-${item.status}`}>
              {item.status === "in_progress" && <span className="codez-step-spinner" />}
              {planStatusLabel(t, item.status)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ToolStepCard({
  step,
  onToggle,
}: {
  step: ToolStep;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const maxResultLen = 400;
  const result = step.result ?? "";
  const truncated = result.length > maxResultLen;
  const [showFull, setShowFull] = useState(false);
  const statusClass = !step.completed ? "step-running" : step.isError ? "step-error" : "step-ok";

  return (
    <div className={`codez-tool-step-card ${statusClass}`}>
      <button type="button" className="codez-tool-step-header" onClick={onToggle} aria-expanded={step.expanded}>
        <span className="codez-tool-step-icon">{toolIcon(step.name)}</span>
        <span className="codez-tool-step-name">{step.name}</span>
        <span className="codez-tool-step-summary">{toolSummary(step.name, step.input)}</span>
        <span className={`codez-tool-step-status ${statusClass}`}>
          {!step.completed ? (
            <span className="codez-step-spinner" aria-label="running" />
          ) : step.isError ? (
            "✕"
          ) : (
            "✓"
          )}
        </span>
        <span className="codez-tool-step-chevron">{step.expanded ? "▲" : "▼"}</span>
      </button>
      {step.expanded && (
        <div className="codez-tool-step-body">
          <div className="codez-tool-step-section">
            <span className="codez-tool-step-section-label">{t("chat.toolStepInput")}</span>
            <pre className="codez-tool-step-pre">
              {typeof step.input === "string" ? step.input : JSON.stringify(step.input, null, 2)}
            </pre>
          </div>
          {step.completed && (
            <div className="codez-tool-step-section">
              <span className={`codez-tool-step-section-label ${step.isError ? "label-error" : ""}`}>
                {step.isError ? t("chat.toolStepError") : t("chat.toolStepOutput")}
              </span>
              <pre className={`codez-tool-step-pre ${step.isError ? "pre-error" : ""}`}>
                {showFull || !truncated ? result : `${result.slice(0, maxResultLen)}…`}
              </pre>
              {truncated && (
                <button
                  type="button"
                  className="codez-tool-step-show-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFull((v) => !v);
                  }}
                >
                  {showFull ? t("chat.toolStepShowLess") : t("chat.toolStepShowMore")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface TaskPanelProps {
  planItems: PlanTodoItem[];
  toolSteps: ToolStep[];
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: "todo" | "tools";
  onTabChange: (tab: "todo" | "tools") => void;
  onToggleToolStep: (id: string) => void;
  /** Extra class for layout tweaks (e.g. agent vs IDE spacing). */
  className?: string;
}

export default function TaskPanel({
  planItems,
  toolSteps,
  busy,
  open,
  onOpenChange,
  tab,
  onTabChange,
  onToggleToolStep,
  className,
}: TaskPanelProps) {
  const { t } = useTranslation();

  if (planItems.length === 0 && toolSteps.length === 0) return null;

  return (
    <div className={`codez-task-panel${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="codez-task-panel-header"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <div className="codez-task-panel-title">
          <span className="codez-task-panel-label">{t("chat.taskPanel")}</span>
          {planItems.length > 0 && (
            <span className="codez-task-badge">
              Todo · {busy ? t("chat.planWorking", { count: planItems.length }) : planItems.length}
            </span>
          )}
          {toolSteps.length > 0 && (
            <span className="codez-task-badge">
              Tools · {busy ? t("chat.agentWorking") : t("chat.agentSteps", { count: toolSteps.length })}
            </span>
          )}
        </div>
        <span className="codez-task-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="codez-task-panel-body">
          <div className="codez-task-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`codez-task-tab ${tab === "todo" ? "active" : ""}`}
              onClick={() => onTabChange("todo")}
              disabled={planItems.length === 0}
            >
              Todo
              {planItems.length > 0 && <span className="codez-task-tab-count">{planItems.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              className={`codez-task-tab ${tab === "tools" ? "active" : ""}`}
              onClick={() => onTabChange("tools")}
              disabled={toolSteps.length === 0}
            >
              Tools
              {toolSteps.length > 0 && <span className="codez-task-tab-count">{toolSteps.length}</span>}
            </button>
          </div>
          <div className="codez-task-panel-content">
            {tab === "todo" && planItems.length > 0 && <PlanPanel items={planItems} />}
            {tab === "tools" && toolSteps.length > 0 && (
              <div className="codez-tool-steps-scroll">
                {toolSteps.map((step) => (
                  <ToolStepCard key={step.id} step={step} onToggle={() => onToggleToolStep(step.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
