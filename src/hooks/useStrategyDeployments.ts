'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  DeployedStrategyRow,
  DeploymentHistoryRow,
} from '@/lib/strategy-hub/types';
import type { DeploymentLifecycle } from '@/lib/strategy-hub/deploymentLifecycle';
import { QUERY_GC_TIME, visibleRefetchInterval } from '@/lib/query/queryPolicy';

export interface DeployedStrategySummary extends DeployedStrategyRow {
  displayName: string;
  category: string;
  deploymentLifecycle: DeploymentLifecycle;
}

export interface DeploymentAuditEntry extends DeploymentHistoryRow {
  displayName: string;
  lifecycleLabel: string;
}

export interface StrategyDeploymentsResponse {
  ok: true;
  deployed: DeployedStrategySummary[];
  audit: DeploymentAuditEntry[];
  totalDeployed: number;
}

export function useStrategyDeployments(opts?: { strategyId?: string; limit?: number }) {
  return useQuery({
    queryKey: ['strategy-deployments', opts?.strategyId ?? null, opts?.limit ?? 50],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.strategyId) params.set('strategyId', opts.strategyId);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const qs = params.toString();
      const res = await fetch(`/api/strategies/deployments${qs ? `?${qs}` : ''}`, {
        cache: 'no-store',
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('Failed to load deployments');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load deployments');
      return body as StrategyDeploymentsResponse;
    },
    staleTime: 30_000,
    gcTime: QUERY_GC_TIME.DEFAULT,
    refetchInterval: visibleRefetchInterval(60_000),
    refetchOnWindowFocus: false,
  });
}
