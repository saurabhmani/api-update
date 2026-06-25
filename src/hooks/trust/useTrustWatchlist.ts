'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustWatchlistItem } from '@/lib/trust-layer/types';

export function useTrustWatchlist() {
  return useQuery({
    queryKey: ['trust', 'watchlist'],
    queryFn: async () => {
      const res = await fetch('/api/trust/watchlist', { cache: 'no-store', credentials: 'include' });
      if (!res.ok) throw new Error('Watchlist fetch failed');
      const body = await res.json();
      return {
        items: body.data as TrustWatchlistItem[],
        count: body.count as number,
        categories: body.categories as Record<string, number>,
      };
    },
    refetchInterval: 90_000,
  });
}
