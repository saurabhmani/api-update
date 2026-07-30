'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyHubListResponse } from '@/lib/strategy-hub/types';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

export interface HubFilters {
  category?: string | null;
  featuredOnly?: boolean;
  paperReadyOnly?: boolean;
  window?: string;
  timeframe?: string | null;
  direction?: string | null;
  marketType?: string | null;
  status?: string | null;
  risk?: string | null;
}

function buildQuery(filters: HubFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.featuredOnly) params.set('featured', '1');
  if (filters.paperReadyOnly) params.set('paperReady', '1');
  if (filters.timeframe) params.set('timeframe', filters.timeframe);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.marketType) params.set('marketType', filters.marketType);
  if (filters.status) params.set('status', filters.status);
  if (filters.risk) params.set('risk', filters.risk);
  params.set('window', filters.window ?? '90D');
  return params.toString();
}

export function useStrategyHub(filters: HubFilters = {}) {
  return useQuery({
    queryKey: ['strategy-hub', filters],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/strategies/registry?${buildQuery(filters)}`, {
        cache: 'no-store',
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('Strategy hub fetch failed');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Strategy hub fetch failed');
      return body as StrategyHubListResponse & { ok: true };
    },
    staleTime: 60_000,
    gcTime: QUERY_GC_TIME.REFERENCE,
    refetchInterval: visibleRefetchInterval(120_000),
    refetchOnWindowFocus: false,
  });
}
