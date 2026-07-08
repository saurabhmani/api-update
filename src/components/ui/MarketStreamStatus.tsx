'use client';

import { useEffect, useState } from 'react';
import type { MarketStreamStatus } from '@/lib/marketData/marketStreamTypes';

interface Props {
  status:     MarketStreamStatus;
  lastAt?:    number | null;
  staleMs?:   number;
  className?: string;
}

type Tone = 'live' | 'connecting' | 'reconnecting' | 'stale' | 'off';

const PALETTE: Record<Tone, { bg: string; fg: string; dot: string }> = {
  live:         { bg: 'rgba(16,185,129,0.12)', fg: '#10B981', dot: '#10B981' },
  connecting:   { bg: 'rgba(59,130,246,0.14)', fg: '#3B82F6', dot: '#3B82F6' },
  reconnecting: { bg: 'rgba(245,158,11,0.14)', fg: '#F59E0B', dot: '#F59E0B' },
  stale:        { bg: 'rgba(148,163,184,0.16)', fg: '#94A3B8', dot: '#94A3B8' },
  off:          { bg: 'rgba(239,68,68,0.14)',  fg: '#EF4444', dot: '#EF4444' },
};

const LABEL: Record<MarketStreamStatus, string> = {
  connected:    'CONNECTED',
  connecting:   'CONNECTING',
  reconnecting: 'RECONNECTING',
  disconnected: 'DISCONNECTED',
};

export default function MarketStreamStatus({
  status, lastAt, staleMs = 15_000, className,
}: Props) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const id = setInterval(() => rerender((n) => n + 1), 2_000);
    return () => clearInterval(id);
  }, []);

  const age = lastAt == null ? null : Date.now() - lastAt;
  let tone: Tone;
  if (status === 'disconnected') tone = 'off';
  else if (status === 'connecting') tone = 'connecting';
  else if (status === 'reconnecting') tone = 'reconnecting';
  else if (age != null && age > staleMs) tone = 'stale';
  else tone = 'live';

  const c = PALETTE[tone];
  const pulsing = tone === 'reconnecting' || tone === 'connecting';

  return (
    <span
      className={className}
      title={age != null ? `Last tick ${Math.max(0, Math.round(age / 1000))}s ago` : LABEL[status]}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '2px 8px', borderRadius: 9999,
        background: c.bg, color: c.fg,
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        lineHeight: 1, whiteSpace: 'nowrap', userSelect: 'none',
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: 9999, background: c.dot,
          boxShadow: pulsing ? `0 0 6px ${c.dot}` : 'none',
        }}
      />
      {tone === 'stale' ? 'STALE' : LABEL[status]}
    </span>
  );
}
