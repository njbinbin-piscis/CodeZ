/** Brand mark — stylized “Z” used beside “Code” in the title bar. */

interface ZLogoProps {
  size?: number;
  className?: string;
}

export default function ZLogo({ size = 20, className }: ZLogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="var(--accent)" />
      <path
        d="M7 7h10M7 17h10M16 7L8 17"
        stroke="#fff"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
