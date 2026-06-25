'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyHubListResponse } from '@/lib/strategy-hub/types';

export interface HubFilters {
  category?: string | null;
  featuredOnly?: boolean;
  paperReadyOnly?: boolean;
  window?: string;
}

function buildQuery(filters: HubFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.featuredOnly) params.set('featured', '1');
  if (filters.paperReadyOnly) params.set('paperReady', '1');
  params.set('window', filters.window ?? '90D');
  return params.toString();
}

export function useStrategyHub(filters: HubFilters = {}) {
  return useQuery({
    queryKey: ['strategy-hub', filters],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/registry?${buildQuery(filters)}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Strategy hub fetch failed');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Strategy hub fetch failed');
      return body as StrategyHubListResponse & { ok: true };
    },
    refetchInterval: 120_000,
  });
}
