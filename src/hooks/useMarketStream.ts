'use client';

import { useEffect, useState } from 'react';
import {
  getMarketStreamClient,
  MARKET_STREAM_SERVER_SNAPSHOT,
  type MarketStreamSnapshot,
} from '@/lib/marketData/marketStreamClient';
import type { MarketStreamStatus } from '@/lib/marketData/marketStreamTypes';

export type { MarketStreamStatus };

export interface UseMarketStreamOptions {
  symbols?: string[];
  receiveAll?: boolean;
}

export interface UseMarketStreamResult {
  status:   MarketStreamStatus;
  snapshot: MarketStreamSnapshot;
  ticks:    MarketStreamSnapshot['ticks'];
  lastAt:   number | null;
  connected: boolean;
}

export function useMarketStream(opts: UseMarketStreamOptions = {}): UseMarketStreamResult {
  const symbols = opts.symbols ?? [];
  const symbolKey = symbols.map((s) => s.toUpperCase()).sort().join(',');

  // useState + effect avoids useSyncExternalStore #185 (subscribe must
  // not synchronously trigger store updates during render).
  const [snapshot, setSnapshot] = useState<MarketStreamSnapshot>(MARKET_STREAM_SERVER_SNAPSHOT);

  useEffect(() => {
    const client = getMarketStreamClient();
    setSnapshot(client.getSnapshot());
    return client.subscribe(() => {
      setSnapshot(client.getSnapshot());
    });
  }, []);

  useEffect(() => {
    const client = getMarketStreamClient();
    if (opts.receiveAll) {
      client.enableReceiveAll();
      return () => client.disableReceiveAll();
    }
    if (!symbols.length) return;
    client.addSymbols(symbols);
    return () => client.removeSymbols(symbols);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey, opts.receiveAll]);

  return {
    status: snapshot.status,
    snapshot,
    ticks: snapshot.ticks,
    lastAt: snapshot.lastAt,
    connected: snapshot.status === 'connected',
  };
}
