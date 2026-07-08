// ════════════════════════════════════════════════════════════════
//  useLivePrice — single-symbol wrapper around useMarketStream
// ════════════════════════════════════════════════════════════════

'use client';

import { useEffect, useRef, useState } from 'react';
import { useMarketStream } from '@/hooks/useMarketStream';
import type { MarketStreamTick } from '@/lib/marketData/marketStreamTypes';
import type { LivePrice } from './useLivePrices';

interface Options {
  throttleMs?: number;
  autoSubscribe?: boolean;
}

const HEARTBEAT_MS = 60_000;

async function requestSubscribe(symbol: string): Promise<void> {
  try {
    await fetch('/api/market-data/subscribe', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ symbols: [symbol] }),
      keepalive: true,
    });
  } catch { /* retry on next heartbeat */ }
}

function toLivePrice(tick: MarketStreamTick): LivePrice {
  return {
    symbol:  tick.symbol,
    price:   tick.price,
    change:  tick.change,
    pChange: tick.pChange,
    close:   tick.close ?? null,
    source:  tick.source,
    ts:      tick.ts,
  };
}

export interface UseLivePriceResult {
  live:      LivePrice | null;
  connected: boolean;
  lastAt:    number | null;
  streamStatus: ReturnType<typeof useMarketStream>['status'];
}

export function useLivePrice(
  symbol: string | null | undefined,
  opts: Options = {},
): UseLivePriceResult {
  const throttleMs    = Math.max(0, opts.throttleMs ?? 150);
  const autoSubscribe = opts.autoSubscribe ?? true;
  const key = (symbol ?? '').toUpperCase();

  const { ticks, connected, lastAt, status } = useMarketStream({
    symbols: key ? [key] : [],
  });

  const fresh = key ? (ticks.get(key) ? toLivePrice(ticks.get(key)!) : null) : null;

  useEffect(() => {
    if (!autoSubscribe || !key) return;
    void requestSubscribe(key);
    const id = setInterval(() => { void requestSubscribe(key); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [key, autoSubscribe]);

  const [throttled, setThrottled] = useState<LivePrice | null>(fresh);
  const pendingRef   = useRef<LivePrice | null>(fresh);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmitRef  = useRef<number>(0);

  useEffect(() => {
    if (!fresh) {
      pendingRef.current = null;
      setThrottled(null);
      return;
    }
    pendingRef.current = fresh;

    if (throttleMs === 0) {
      lastEmitRef.current = Date.now();
      setThrottled(fresh);
      return;
    }

    const since = Date.now() - lastEmitRef.current;
    if (since >= throttleMs) {
      lastEmitRef.current = Date.now();
      setThrottled(fresh);
      return;
    }
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastEmitRef.current = Date.now();
      setThrottled(pendingRef.current);
    }, throttleMs - since);
  }, [fresh, throttleMs]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { live: throttled, connected, lastAt, streamStatus: status };
}
