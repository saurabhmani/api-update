'use client';

interface Props {
  score: number;
  size?: number;
  showLabel?: boolean;
}

export default function OpportunityScore({ score, size = 40, showLabel = true }: Props) {
  const color  = score >= 70 ? '#16A34A' : score >= 45 ? '#D97706' : '#DC2626';
  const bg     = score >= 70 ? '#DCFCE7' : score >= 45 ? '#FEF3C7' : '#FEE2E2';
  const label  = score >= 70 ? 'High'   : score >= 45 ? 'Medium' : 'Low';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: bg, color, fontWeight: 800,
        fontSize: size * 0.35, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `2px solid ${color}22`,
      }}>
        {score}
      </div>
      {showLabel && <div style={{ fontSize: 10, color, fontWeight: 600 }}>{label}</div>}
    </div>
  );
}
