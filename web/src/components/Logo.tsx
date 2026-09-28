export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0A1630" />
      <g fill="#3DFFC2">
        <rect x="5" y="17" width="3.2" height="10" rx="1.6" />
        <rect x="10" y="12" width="3.2" height="15" rx="1.6" />
        <rect x="15" y="7" width="3.2" height="20" rx="1.6" />
        <rect x="20" y="11" width="3.2" height="16" rx="1.6" opacity=".7" />
        <rect x="25" y="16" width="3.2" height="11" rx="1.6" opacity=".45" />
      </g>
    </svg>
  );
}
