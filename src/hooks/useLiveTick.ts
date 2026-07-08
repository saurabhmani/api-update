'use client';

import { useMemo } from 'react';
import type { Tick } from '@/types';
import { useMarketStream } from '@/hooks/useMarketStream';
import type { MarketStreamTick } from '@/lib/marketData/marketStreamTypes';

function streamTickToTick(tick: MarketStreamTick, instrumentKey: string): Tick {
  return {
    instrument_key: instrumentKey,
    ltp:        tick.price,
    open:       tick.open ?? null,
    high:       tick.high ?? null,
    low:        tick.low ?? null,
    close:      tick.close ?? null,
    volume:     tick.volume ?? null,
    net_change: tick.change,
    pct_change: tick.pChange,
    bid:        tick.bid ?? null,
    ask:        tick.ask ?? null,
    ts: new Date(tick.ts).toISOString(),
  };
}

function bareSymbol(key: string): string {
  const up = key.trim().toUpperCase();
  if (up.includes('|')) return up.split('|').pop()!.trim();
  if (up.includes(':')) return up.split(':').pop()!.trim();
  return up;
}

export function useLiveTick(
  instrumentKeys: string[],
  _mode: 'ltpc' | 'full' = 'ltpc',
): { ticks: Record<string, Tick>; connected: boolean; streamStatus: ReturnType<typeof useMarketStream>['status'] } {
  const symbols = useMemo(
    () => [...new Set(instrumentKeys.map(bareSymbol).filter(Boolean))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instrumentKeys.join(',')],
  );

  const { ticks: streamTicks, connected, status } = useMarketStream({ symbols });

  const ticks: Record<string, Tick> = {};
  for (const key of instrumentKeys) {
    const sym = bareSymbol(key);
    const st = streamTicks.get(sym);
    if (st) ticks[key] = streamTickToTick(st, key);
  }

  return { ticks, connected, streamStatus: status };
}
