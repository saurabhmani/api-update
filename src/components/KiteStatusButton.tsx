'use client';
import { useKiteStatus, type KitePhase } from '@/hooks/useKiteStatus';

// ── Styles ──────────────────────────────────────────────────────

const base: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  border: 'none',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'inherit',
  letterSpacing: '0.01em',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  transition: 'background 0.2s, box-shadow 0.2s',
};

const phaseStyles: Record<KitePhase, { bg: string; dot: string; glow: boolean; cursor: string }> = {
  loading:      { bg: '#EAB308', dot: '#fff', glow: false, cursor: 'default' },
  connected:    { bg: '#16A34A', dot: '#fff', glow: true,  cursor: 'default' },
  disconnected: { bg: '#DC2626', dot: '#fff', glow: false, cursor: 'pointer' },
};

// ── Component ───────────────────────────────────────────────────

export default function KiteStatusButton() {
  const { status, phase, connectKite } = useKiteStatus();

  const s = phaseStyles[phase];

  const label =
    phase === 'loading'
      ? 'Checking…'
      : phase === 'connected'
        ? `Kite Connected${status?.subscribedCount ? ` · ${status.subscribedCount}` : ''}`
        : 'Connect Kite';

  const tooltip =
    phase === 'loading'
      ? 'Checking Kite connection status…'
      : phase === 'connected'
        ? `Live market data active — Subscribed=${status?.subscribedCount ?? 0}  Cached=${status?.ticksCached ?? 0}${status?.marketLabel ? `  Market: ${status.marketLabel}` : ''}`
        : status?.lastError
          ? `Last error: ${status.lastError}`
          : status?.kiteAuth === 'expired'
            ? 'Kite token expired — click to reconnect'
            : 'Click to connect to Zerodha Kite for live data';

  const handleClick = () => {
    if (phase === 'disconnected') {
      connectKite();
    }
  };

  return (
    <button
      onClick={handleClick}
      title={tooltip}
      disabled={phase === 'loading' || phase === 'connected'}
      style={{
        ...base,
        background: s.bg,
        color: '#fff',
        cursor: s.cursor,
        opacity: phase === 'loading' ? 0.85 : 1,
        boxShadow: phase === 'connected' ? '0 0 8px rgba(22,163,74,0.4)' : 'none',
      }}
      aria-label={label}
    >
      {/* Status dot */}
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: s.dot,
          opacity: s.glow ? 1 : 0.6,
          boxShadow: s.glow ? '0 0 6px #fff' : 'none',
          animation: phase === 'loading' ? 'kite-pulse 1.2s ease-in-out infinite' : 'none',
        }}
      />

      {label}

      {/* Pulse keyframe injected inline (only once) */}
      <style>{`
        @keyframes kite-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </button>
  );
}
