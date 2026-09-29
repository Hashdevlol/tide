/** Tide mark: "≈" — two waves with square-cut ends on a sharp black tile. Works from 16px to 800px. */
export function LogoMark({ size = 30, invert = false }: { size?: number; invert?: boolean }) {
  const bg = invert ? '#EFEDE6' : '#0C0C0C';
  const fg = invert ? '#0C0C0C' : '#FFFFFF';
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" shapeRendering="geometricPrecision">
      <rect width="32" height="32" fill={bg} />
      <g fill="none" stroke={fg} strokeWidth="3.4" strokeLinecap="butt" strokeLinejoin="miter">
        <path d="M5 13.2c3.2-4.4 7.2-4.4 11 0s7.8 4.4 11 0" />
        <path d="M5 21.2c3.2-4.4 7.2-4.4 11 0s7.8 4.4 11 0" />
      </g>
    </svg>
  );
}

/** Faceless node mascot: a GPU chip with pins and the ≈ badge. `lit` = serving right now. */
export function NodeMascot({ lit = true, className }: { lit?: boolean; className?: string }) {
  const body = lit ? '#19E57F' : '#C9C6BD';
  const pins = [22, 34, 46, 58, 70];
  return (
    <svg className={className} viewBox="0 0 96 110" aria-hidden="true">
      {pins.map((x) => <rect key={'t' + x} x={x} y="6" width="4" height="12" fill="#0C0C0C" />)}
      {pins.map((x) => <rect key={'b' + x} x={x} y="84" width="4" height="12" fill="#0C0C0C" />)}
      {[30, 44, 58].map((y) => <rect key={'l' + y} x="4" y={y} width="12" height="4" fill="#0C0C0C" />)}
      {[30, 44, 58].map((y) => <rect key={'r' + y} x="80" y={y} width="12" height="4" fill="#0C0C0C" />)}
      <rect x="14" y="16" width="68" height="70" fill={body} stroke="#0C0C0C" strokeWidth="4" />
      <rect x="36" y="38" width="24" height="24" fill="#0C0C0C" />
      <g fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="butt">
        <path d="M40 47.5c2.4-3.2 5.3-3.2 8 0s5.6 3.2 8 0" />
        <path d="M40 53.5c2.4-3.2 5.3-3.2 8 0s5.6 3.2 8 0" />
      </g>
      <ellipse cx="48" cy="104" rx="26" ry="3.5" fill="#0C0C0C" opacity=".18" />
    </svg>
  );
}
