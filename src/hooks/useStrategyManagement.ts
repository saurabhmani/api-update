'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyManagementStatus, StrategyModeHistoryRow } from '@/lib/strategy-hub/types';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

export interface ModeActivityRow extends StrategyModeHistoryRow {
  displayName: string;
}

export interface StrategyManagementResponse {
  ok: true;
  status: StrategyManagementStatus;
  activity: ModeActivityRow[];
  canManage: boolean;
}

export function useStrategyManagement(opts?: { strategyId?: string; limit?: number }) {
  return useQuery({
    queryKey: ['strategy-management', opts?.strategyId ?? null, opts?.limit ?? 30],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.strategyId) params.set('strategyId', opts.strategyId);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const qs = params.toString();
      const res = await fetch(`/api/strategies/management${qs ? `?${qs}` : ''}`, {
        cache: 'no-store',
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('Failed to load strategy management status');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load strategy management status');
      return body as StrategyManagementResponse;
    },
    staleTime: 30_000,
    gcTime: QUERY_GC_TIME.DEFAULT,
    refetchInterval: visibleRefetchInterval(60_000),
    refetchOnWindowFocus: false,
  });
}
