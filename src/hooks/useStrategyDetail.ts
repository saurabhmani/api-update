'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyHubDetail } from '@/lib/strategy-hub/types';

export function useStrategyDetail(strategyId: string, window = '90D') {
  return useQuery({
    queryKey: ['strategy-detail', strategyId, window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/${strategyId}?window=${window}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Strategy detail fetch failed');
      const body = await res.json();
      return body.data as StrategyHubDetail;
    },
    enabled: !!strategyId,
    refetchInterval: 120_000,
  });
}
