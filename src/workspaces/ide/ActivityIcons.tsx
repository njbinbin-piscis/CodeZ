import type { ReactNode } from "react";

interface ActivityIconProps {
  size?: number;
}

function IconWrap({ size = 22, children }: ActivityIconProps & { children: ReactNode }) {
  return (
    <span className="activity-icon" aria-hidden>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        {children}
      </svg>
    </span>
  );
}

export function ExplorerIcon(props: ActivityIconProps) {
  return (
    <IconWrap {...props}>
      <path d="M4 6h6l2 2h8v10H4V6z" strokeLinejoin="round" />
      <path d="M4 6v12" opacity="0.35" />
    </IconWrap>
  );
}

export function SearchIcon(props: ActivityIconProps) {
  return (
    <IconWrap {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" strokeLinecap="round" />
    </IconWrap>
  );
}

export function SourceControlIcon(props: ActivityIconProps) {
  return (
    <IconWrap {...props}>
      <circle cx="6" cy="6" r="2.25" fill="currentColor" stroke="none" />
      <circle cx="6" cy="18" r="2.25" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="2.25" fill="currentColor" stroke="none" />
      <path d="M6 8.25v7.5M8.25 6h5.5a2.25 2.25 0 0 1 2.25 2.25v3.5" strokeLinecap="round" />
    </IconWrap>
  );
}

export function TerminalIcon(props: ActivityIconProps) {
  return (
    <IconWrap {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}
