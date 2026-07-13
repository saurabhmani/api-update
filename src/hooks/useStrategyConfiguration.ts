'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyConfigurationView, StrategyConfigHistoryRow } from '@/lib/strategy-hub/types';
import type { StrategyConfigPreviewResult } from '@/lib/strategy-hub/types';

export interface StrategyConfigResponse {
  ok: true;
  config: StrategyConfigurationView;
  canManage: boolean;
}

export function useStrategyConfiguration(strategyId: string) {
  return useQuery({
    queryKey: ['strategy-config', strategyId],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/${strategyId}/config`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Failed to load configuration');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load configuration');
      return body as StrategyConfigResponse;
    },
    enabled: !!strategyId,
    refetchInterval: 120_000,
  });
}

export function useStrategyConfigHistory(strategyId: string, limit = 20) {
  return useQuery({
    queryKey: ['strategy-config-history', strategyId, limit],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/${strategyId}/config/history?limit=${limit}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load configuration history');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load configuration history');
      return body.history as StrategyConfigHistoryRow[];
    },
    enabled: !!strategyId,
  });
}

export type { StrategyConfigPreviewResult };
