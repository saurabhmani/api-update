'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustDashboardPayload } from '@/lib/trust-layer/types';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? 'Request failed');
  return body.data as T;
}

export function useTrustDashboard() {
  return useQuery({
    queryKey: ['trust', 'dashboard'],
    queryFn: () => fetchJson<TrustDashboardPayload>('/api/trust/dashboard'),
    refetchInterval: 60_000,
  });
}
