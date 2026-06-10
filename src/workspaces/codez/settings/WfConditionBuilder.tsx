import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import DropdownSelect from "../../../components/DropdownSelect";
import {
  formatCondition,
  parseCondition,
  type ConditionOp,
  type ParsedCondition,
} from "../../../services/tauri/workflowExpr";
import "./WfConditionBuilder.css";

interface WfConditionBuilderProps {
  value: string;
  onChange: (expr: string) => void;
  blackboardKeys: string[];
  /** When true, empty expression is allowed (e.g. loop exit_when). */
  optional?: boolean;
}

const OPS_NEED_VALUE: ConditionOp[] = ["contains", "not_contains", "eq", "neq"];

export default function WfConditionBuilder({
  value,
  onChange,
  blackboardKeys,
  optional = false,
}: WfConditionBuilderProps) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);

  const parsed = useMemo(() => parseCondition(value), [value]);
  const keyOptions = useMemo(
    () => blackboardKeys.map((k) => ({ id: k, label: k })),
    [blackboardKeys],
  );

  const opOptions = useMemo(
    () =>
      (
        [
          "contains",
          "not_contains",
          "eq",
          "neq",
          "truthy",
        ] as ConditionOp[]
      ).map((op) => ({
        id: op,
        label: t(`workflow.condition.op.${op}`),
      })),
    [t],
  );

  const unknownKey =
    parsed.key.trim() !== "" &&
    blackboardKeys.length > 0 &&
    !blackboardKeys.includes(parsed.key.trim());

  const apply = useCallback(
    (next: ParsedCondition) => {
      onChange(formatCondition(next));
    },
    [onChange],
  );

  const patch = useCallback(
    (patch: Partial<ParsedCondition>) => {
      apply({ ...parsed, ...patch });
    },
    [apply, parsed],
  );

  const preview = formatCondition(parsed) || (optional ? t("workflow.condition.none") : "");

  if (advanced) {
    return (
      <div className="wf-condition">
        <textarea
          className="wf-condition-advanced"
          rows={2}
          value={value}
          placeholder={t("workflow.condition.advancedPlaceholder")}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="wf-condition-toggle" onClick={() => setAdvanced(false)}>
          {t("workflow.condition.useBuilder")}
        </button>
        {preview && <p className="wf-condition-preview">{t("workflow.condition.preview", { expr: preview })}</p>}
      </div>
    );
  }

  return (
    <div className="wf-condition">
      <div className="wf-condition-row">
        <span className="wf-condition-label">{t("workflow.condition.key")}</span>
        <DropdownSelect
          variant="field"
          value={parsed.key}
          placeholder={t("workflow.condition.keyPlaceholder")}
          options={keyOptions}
          onChange={(k) => patch({ key: k })}
        />
      </div>
      <div className="wf-condition-row">
        <span className="wf-condition-label">{t("workflow.condition.operator")}</span>
        <DropdownSelect
          variant="field"
          value={parsed.op}
          options={opOptions}
          onChange={(op) => patch({ op: op as ConditionOp })}
        />
      </div>
      {OPS_NEED_VALUE.includes(parsed.op) && (
        <div className="wf-condition-row">
          <span className="wf-condition-label">{t("workflow.condition.value")}</span>
          <input
            value={parsed.value}
            placeholder={t("workflow.condition.valuePlaceholder")}
            onChange={(e) => patch({ value: e.target.value })}
          />
        </div>
      )}
      {unknownKey && (
        <p className="wf-condition-warn">{t("workflow.condition.unknownKey", { key: parsed.key.trim() })}</p>
      )}
      {preview && (
        <p className="wf-condition-preview">{t("workflow.condition.preview", { expr: preview })}</p>
      )}
      {optional && !value.trim() && (
        <p className="agentz-settings-hint">{t("workflow.condition.optionalHint")}</p>
      )}
      <button type="button" className="wf-condition-toggle" onClick={() => setAdvanced(true)}>
        {t("workflow.condition.useAdvanced")}
      </button>
    </div>
  );
}
