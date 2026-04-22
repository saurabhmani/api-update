'use client';
import { useState, useEffect, useRef } from 'react';
import type { Tick } from '@/types';

export function useLiveTick(
  instrumentKeys: string[],
  mode: 'ltpc' | 'full' = 'ltpc'
): { ticks: Record<string, Tick>; connected: boolean } {
  const [ticks,     setTicks]     = useState<Record<string, Tick>>({});
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!instrumentKeys.length) return;
    const keysStr = instrumentKeys.join(',');
    const es = new EventSource(`/api/market/stream?keys=${encodeURIComponent(keysStr)}&mode=${mode}`);
    esRef.current = es;
    es.onopen    = () => setConnected(true);
    es.onerror   = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const tick: Tick = JSON.parse(ev.data);
        setTicks(prev => ({ ...prev, [tick.instrument_key]: tick }));
      } catch {}
    };
    return () => { es.close(); setConnected(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentKeys.join(','), mode]);

  return { ticks, connected };
}
