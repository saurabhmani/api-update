'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustStrategyPerformanceRow } from '@/lib/trust-layer/types';

export interface TrustStrategyPerformancePayload {
  rows: TrustStrategyPerformanceRow[];
  window: string;
  sourceStatus?: {
    directOutcomeRows: number;
    observedSnapshotRows: number;
    backtestTradeRows: number;
    strategySnapshots: number;
    evaluatedTrades: number;
  };
  meta?: {
    total: number;
    available: number;
    insufficient: number;
  };
}

export function useTrustStrategyPerformance(window = '90D') {
  return useQuery({
    queryKey: ['trust', 'strategy-performance', window],
    queryFn: async (): Promise<TrustStrategyPerformancePayload> => {
      const res = await fetch(`/api/trust/strategies/performance?window=${window}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Unauthorized — please sign in again');
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `Performance fetch failed (${res.status})`);
      }
      return {
        rows: (body.data ?? []) as TrustStrategyPerformanceRow[],
        window: body.window ?? window,
        sourceStatus: body.sourceStatus,
        meta: body.meta,
      };
    },
    refetchInterval: 300_000,
  });
}
