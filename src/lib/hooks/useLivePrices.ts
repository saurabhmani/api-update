// ════════════════════════════════════════════════════════════════
//  useLivePrices — React hook subscribing to the streamServer WS
//
//  Uses the shared marketStreamClient singleton (one WS per tab).
//  Auto-reconnects with exponential backoff; resubscribes on reconnect.
// ════════════════════════════════════════════════════════════════

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMarketStream } from '@/hooks/useMarketStream';
import type { MarketStreamTick } from '@/lib/marketData/marketStreamTypes';
import { isMarketWsDisabled } from '@/lib/marketData/wsUrl';

export type LivePrice = {
  symbol:  string;
  price:   number | null;
  change:  number | null;
  pChange: number | null;
  close?:  number | null;
  source:  string;
  ts:      number;
};

export type LiveMode =
  | 'STREAM_LIVE'
  | 'STREAM_FALLBACK'
  | 'MARKET_CLOSED'
  | 'WAITING'
  | 'DISCONNECTED';

export interface UseLivePricesResult {
  prices:    Map<string, LivePrice>;
  connected: boolean;
  lastAt:    number | null;
  marketOpen:  boolean;
  marketLabel: string;
  source:      'indianapi' | 'yahoo' | 'none' | null;
  mode:        LiveMode;
  /** WebSocket connection lifecycle for status badges. */
  streamStatus: ReturnType<typeof useMarketStream>['status'];
}

const HEALTH_POLL_MS =
  Number(process.env.NEXT_PUBLIC_HEALTH_POLL_MS) || 5_000;
const LIVE_FRESH_MS = 10_000;

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

export function useLivePrices(): UseLivePricesResult {
  const { lastAt, connected, status, snapshot } = useMarketStream({ receiveAll: true });

  const [marketOpen,  setMarketOpen]  = useState(false);
  const [marketLabel, setMarketLabel] = useState('Loading…');
  const [source, setSource] = useState<'indianapi' | 'yahoo' | 'none' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const prices = useMemo(() => {
    const map = new Map<string, LivePrice>();
    for (const [sym, tick] of snapshot.ticks) {
      map.set(sym, toLivePrice(tick));
    }
    return map;
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/market-data/health', { cache: 'no-store' });
        const j = await res.json().catch(() => null);
        if (cancelled || !j) return;
        if (j.market && typeof j.market.isOpen === 'boolean') setMarketOpen(j.market.isOpen);
        if (j.market && typeof j.market.label === 'string') setMarketLabel(j.market.label);
        if (j.source === 'indianapi' || j.source === 'yahoo' || j.source === 'none') {
          setSource(j.source);
        }
      } catch { /* retry next tick */ }
    };
    poll();
    const id = setInterval(poll, HEALTH_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const wsDisabled = isMarketWsDisabled();
  let mode: LiveMode;
  if (wsDisabled || status === 'disconnected') {
    mode = 'DISCONNECTED';
  } else if (source === 'yahoo') {
    mode = 'STREAM_FALLBACK';
  } else if (!marketOpen) {
    mode = 'MARKET_CLOSED';
  } else if (lastAt != null && now - lastAt <= LIVE_FRESH_MS) {
    mode = 'STREAM_LIVE';
  } else if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
    mode = 'WAITING';
  } else {
    mode = 'DISCONNECTED';
  }

  return {
    prices,
    connected: connected && !wsDisabled,
    lastAt,
    marketOpen,
    marketLabel,
    source,
    mode,
    streamStatus: status,
  };
}
