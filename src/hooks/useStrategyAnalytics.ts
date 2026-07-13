'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyAnalyticsDashboard } from '@/lib/strategy-hub/analytics/types';
import type { AnalyticsWindow } from '@/lib/strategy-hub/analytics/types';

export type AnalyticsSection =
  | 'summary'
  | 'regime'
  | 'sector'
  | 'confidence'
  | 'trends'
  | 'learning'
  | 'rankings'
  | 'charts';

interface UseStrategyAnalyticsOptions {
  window?: AnalyticsWindow;
  sections?: AnalyticsSection[];
  enabled?: boolean;
}

export function useStrategyAnalytics(
  strategyId: string,
  opts: UseStrategyAnalyticsOptions = {},
) {
  const window = opts.window ?? '90D';
  const sections = opts.sections?.join(',') ?? 'summary,regime,sector,confidence,trends,learning,rankings,charts';

  return useQuery({
    queryKey: ['strategy-analytics', strategyId, window, sections],
    queryFn: async () => {
      const res = await fetch(
        `/api/strategies/${strategyId}/analytics?window=${window}&include=${sections}`,
        { cache: 'no-store', credentials: 'include' },
      );
      if (!res.ok) throw new Error('Failed to load strategy analytics');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load analytics');
      return body as StrategyAnalyticsDashboard & { ok: true };
    },
    enabled: opts.enabled !== false && !!strategyId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useStrategyRankings(window: AnalyticsWindow = '90D') {
  return useQuery({
    queryKey: ['strategy-rankings', window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/analytics/rankings?window=${window}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load rankings');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load rankings');
      return body;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
