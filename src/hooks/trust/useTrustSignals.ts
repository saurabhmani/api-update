'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustSignalBoardRow } from '@/lib/trust-layer/types';

export interface SignalBoardFilters {
  status?: 'active' | 'closed' | 'all';
  direction?: 'BUY' | 'SELL';
  strategy?: string;
  limit?: number;
}

function buildQuery(filters: SignalBoardFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.strategy) params.set('strategy', filters.strategy);
  params.set('limit', String(filters.limit ?? 50));
  return params.toString();
}

async function fetchSignals(filters: SignalBoardFilters): Promise<TrustSignalBoardRow[]> {
  const res = await fetch(`/api/trust/signals?${buildQuery(filters)}`, {
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Signals fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? 'Signals fetch failed');
  return body.data as TrustSignalBoardRow[];
}

export function useTrustSignals(filters: SignalBoardFilters = { status: 'active', limit: 50 }) {
  return useQuery({
    queryKey: ['trust', 'signals', filters],
    queryFn: () => fetchSignals(filters),
    refetchInterval: 45_000,
  });
}

export function useSignalReasons(signalId: number | null) {
  return useQuery({
    queryKey: ['trust', 'reasons', signalId],
    queryFn: async () => {
      const res = await fetch(`/api/trust/signals/${signalId}/reasons`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Reasons fetch failed');
      const body = await res.json();
      return body.data;
    },
    enabled: signalId !== null,
  });
}

export function useSignalWarnings(signalId: number | null) {
  return useQuery({
    queryKey: ['trust', 'warnings', signalId],
    queryFn: async () => {
      const res = await fetch(`/api/trust/signals/${signalId}/warnings`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Warnings fetch failed');
      const body = await res.json();
      return body.data;
    },
    enabled: signalId !== null,
  });
}
