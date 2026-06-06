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

/** Open / change project folder. */
export function FolderIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
        strokeLinejoin="round"
      />
    </SvgIcon>
  );
}

/** Marketplace / store (storefront). */
export function StoreIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path
        d="M3 9l1.5-4.5A1 1 0 0 1 5.45 4h13.1a1 1 0 0 1 .95.5L21 9M3 9v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9M3 9h18"
        strokeLinejoin="round"
      />
      <path d="M3 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" />
    </SvgIcon>
  );
}

/** Settings / preferences (gear). */
export function SettingsIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" />
    </SvgIcon>
  );
}

/** Switch to light appearance. */
export function SunIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        strokeLinecap="round"
      />
    </SvgIcon>
  );
}

/** Switch to dark appearance. */
export function MoonIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path
        d="M20 14.5A7.5 7.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5z"
        strokeLinejoin="round"
      />
    </SvgIcon>
  );
}

/** Close / dismiss (e.g. close open project folder). */
export function CloseIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </SvgIcon>
  );
}

/** Embedded browser panel. */
export function BrowserIcon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.4 2.5 15.6 0 18M12 3c-2.5 2.4-2.5 15.6 0 18" />
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
