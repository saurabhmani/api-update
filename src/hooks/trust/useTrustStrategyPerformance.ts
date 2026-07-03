'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustStrategyPerformanceRow } from '@/lib/trust-layer/types';

export function useTrustStrategyPerformance(window = '90D') {
  return useQuery({
    queryKey: ['trust', 'strategy-performance', window],
    queryFn: async () => {
      const res = await fetch(`/api/trust/strategies/performance?window=${window}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Performance fetch failed');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Performance fetch failed');
      return body.data as TrustStrategyPerformanceRow[];
    },
    refetchInterval: 300_000,
  });
}
