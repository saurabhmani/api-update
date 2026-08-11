'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustWatchlistItem } from '@/lib/trust-layer/types';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

export function useTrustWatchlist() {
  return useQuery({
    queryKey: ['trust', 'watchlist'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/trust/watchlist', { cache: 'no-store', credentials: 'include', signal });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Unauthorized — please sign in again');
      if (!res.ok || body.ok === false) {
        throw new Error(body.error ?? `Watchlist fetch failed (${res.status})`);
      }
      return {
        items: (body.data ?? []) as TrustWatchlistItem[],
        count: body.count as number,
        categories: body.categories as Record<string, number>,
      };
    },
    staleTime: 45_000,
    gcTime: QUERY_GC_TIME.DEFAULT,
    refetchInterval: visibleRefetchInterval(90_000),
    refetchOnWindowFocus: false,
  });
}
