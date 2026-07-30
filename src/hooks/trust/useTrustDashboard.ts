'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustDashboardPayload } from '@/lib/trust-layer/types';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'include', signal });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? 'Request failed');
  return body.data as T;
}

export function useTrustDashboard() {
  return useQuery({
    queryKey: ['trust', 'dashboard'],
    queryFn: ({ signal }) => fetchJson<TrustDashboardPayload>('/api/trust/dashboard', signal),
    staleTime: 30_000,
    gcTime: QUERY_GC_TIME.DEFAULT,
    refetchInterval: visibleRefetchInterval(60_000),
    refetchOnWindowFocus: false,
  });
}
