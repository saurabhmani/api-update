'use client';

interface Props {
  value: number;
  max?: number;
  color?: string;
  size?: number;
  strokeWidth?: number;
}

export default function RingProgress({
  value,
  max = 100,
  color = '#0B1F3A',
  size = 96,
  strokeWidth = 7,
}: Props) {
  const r = (size - strokeWidth * 2) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const dash = (pct / 100) * circ;

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#E8ECF1"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.7s ease' }}
      />
    </svg>
  );
}
