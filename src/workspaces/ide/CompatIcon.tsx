import { useTranslation } from "react-i18next";

export type CompatStatus = "ok" | "warn" | "unknown";

interface CompatIconProps {
  status: CompatStatus;
  /** engines.vscode range, when known */
  range?: string;
  hostVersion?: string;
}

function IconSvg({ status }: { status: CompatStatus }) {
  if (status === "ok") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.25" />
        <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "warn") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M8 2.5l6.5 11H1.5L8 2.5z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <path d="M8 6.5v3.5M8 11.5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 7v4M8 5.25h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Fixed-size compatibility indicator; full detail in a hover tooltip. */
export default function CompatIcon({ status, range, hostVersion }: CompatIconProps) {
  const { t } = useTranslation();

  const tip =
    status === "ok"
      ? t("extensions.compatTooltipOk", { range: range ?? "*" })
      : status === "warn"
        ? t("extensions.compatRequires", { range: range ?? "?", host: hostVersion ?? "?" })
        : t("extensions.compatTooltipUnknown");

  const label =
    status === "ok"
      ? t("extensions.compatBadgeOk")
      : status === "warn"
        ? t("extensions.compatBadgeWarn")
        : t("extensions.compatTooltipUnknown");

  return (
    <span className={`codez-compat-icon ${status}`} role="img" aria-label={label}>
      <IconSvg status={status} />
      <span className="codez-compat-tip" role="tooltip">
        {tip}
      </span>
    </span>
  );
}
