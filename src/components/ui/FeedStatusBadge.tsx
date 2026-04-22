'use client';

import { useEffect, useState } from 'react';

interface Props {
  connected: boolean;
  lastAt:    number | null;
  /** Source of the most recent frame for the symbol being displayed. */
  source?:   'kite' | 'yahoo' | null;
  /** Frame older than this (ms) → STALE. Default 15s. */
  staleMs?:  number;
  className?: string;
}

type Tone = 'live' | 'fallback' | 'idle' | 'stale' | 'off';

const PALETTE: Record<Tone, { bg: string; fg: string; dot: string }> = {
  live:     { bg: 'rgba(16,185,129,0.12)', fg: '#10B981', dot: '#10B981' },
  fallback: { bg: 'rgba(245,158,11,0.14)', fg: '#F59E0B', dot: '#F59E0B' },
  stale:    { bg: 'rgba(148,163,184,0.16)', fg: '#94A3B8', dot: '#94A3B8' },
  idle:     { bg: 'rgba(59,130,246,0.14)', fg: '#3B82F6', dot: '#3B82F6' },
  off:      { bg: 'rgba(239,68,68,0.14)',  fg: '#EF4444', dot: '#EF4444' },
};

export default function FeedStatusBadge({
  connected, lastAt, source, staleMs = 15_000, className,
}: Props) {
  // Keep age evaluation fresh even when no new ticks arrive — without
  // this, a feed that goes quiet would stay stuck on "LIVE" forever.
  const [, rerender] = useState(0);
  useEffect(() => {
    const id = setInterval(() => rerender((n) => n + 1), 2_000);
    return () => clearInterval(id);
  }, []);

  const age = lastAt == null ? null : Date.now() - lastAt;

  let label: string;
  let tone: Tone;
  if (!connected) {
    label = 'DISCONNECTED'; tone = 'off';
  } else if (age != null && age > staleMs) {
    label = 'STALE';        tone = 'stale';
  } else if (source === 'yahoo') {
    label = 'YAHOO FALLBACK'; tone = 'fallback';
  } else if (source === 'kite') {
    label = 'KITE LIVE';    tone = 'live';
  } else {
    label = 'CONNECTING';   tone = 'idle';
  }
  const c = PALETTE[tone];
  const pulsing = tone === 'live' || tone === 'fallback';

  return (
    <span
      className={className}
      title={age != null ? `Last tick ${Math.max(0, Math.round(age / 1000))}s ago` : 'Waiting for first tick'}
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
      {label}
    </span>
  );
}
