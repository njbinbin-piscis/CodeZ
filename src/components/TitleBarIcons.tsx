import type { ReactNode } from "react";

interface IconProps {
  size?: number;
}

function SvgIcon({ size = 18, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** AI chat sidebar (IDE mode). */
export function ChatIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 3V6a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <path d="M8 10h8M8 14h5" strokeLinecap="round" />
    </SvgIcon>
  );
}

/** Settings / preferences. */
export function SettingsIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        strokeLinecap="round"
      />
    </SvgIcon>
  );
}

/** VS Code extensions (.vsix). */
export function ExtensionsIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 17.5h7M17.5 14v7" strokeLinecap="round" />
    </SvgIcon>
  );
}

/** ClawHub skills marketplace. */
export function ClawHubIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M12 3l2.2 4.5 5 .7-3.6 3.5.9 5.1L12 14.8 7.5 16.8l.9-5.1L4.8 8.2l5-.7L12 3z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="9" opacity="0.35" />
    </SvgIcon>
  );
}

/** Repository wiki generator. */
export function WikiIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M6 4h12a1 1 0 0 1 1 1v15l-4-2.5L11 20l-4-2.5V5a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6" strokeLinecap="round" />
    </SvgIcon>
  );
}
