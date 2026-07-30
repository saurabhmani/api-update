'use client';

import { useQuery } from '@tanstack/react-query';
import type { ValidationReport } from '@/lib/strategy-hub/validation/types';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

export interface ValidationStatusResponse {
  ok: true;
  latest: { report: ValidationReport; validationId: number; createdAt: string } | null;
  history: Array<{
    id: number;
    overallStatus: string;
    validationScore: number;
    target: string;
    createdAt: string;
    actor: string | null;
  }>;
  canManage: boolean;
}

export function useStrategyValidation(strategyId: string) {
  return useQuery({
    queryKey: ['strategy-validation', strategyId],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/strategies/${strategyId}/validation`, {
        cache: 'no-store',
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('Failed to load validation status');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load validation');
      return body as ValidationStatusResponse;
    },
    enabled: !!strategyId,
    staleTime: 60_000,
    gcTime: QUERY_GC_TIME.DEFAULT,
    refetchInterval: visibleRefetchInterval(120_000),
    refetchOnWindowFocus: false,
  });
}
