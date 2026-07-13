'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StrategyHealthSnapshot, OperationsDashboard, StrategyAlert, ActivityTimelineEntry, AutomationSettings } from '@/lib/strategy-hub/operations/types';
import { marketHoursPollIntervalMs } from '@/lib/strategy-hub/operations/opsCache';

export function useStrategyOperations(enabled = true) {
  const pollMs = marketHoursPollIntervalMs();
  return useQuery({
    queryKey: ['strategy-operations-dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/strategies/operations', {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load operations dashboard');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load operations');
      return body as OperationsDashboard & { ok: true };
    },
    enabled,
    staleTime: pollMs / 2,
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
  });
}

export function useStrategyHealth(enabled = true) {
  return useQuery({
    queryKey: ['strategy-operations-health'],
    queryFn: async () => {
      const res = await fetch('/api/strategies/operations/health', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load health');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      return body.health as StrategyHealthSnapshot[];
    },
    enabled,
    staleTime: 45_000,
    refetchInterval: marketHoursPollIntervalMs(),
  });
}

export function useStrategyAlerts(status: 'open' | 'all' = 'open') {
  return useQuery({
    queryKey: ['strategy-operations-alerts', status],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/operations/alerts?status=${status}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load alerts');
      const body = await res.json();
      return body.alerts as StrategyAlert[];
    },
    staleTime: 30_000,
    refetchInterval: marketHoursPollIntervalMs(),
  });
}

export function useOpsTimeline(search?: string) {
  return useQuery({
    queryKey: ['strategy-operations-timeline', search ?? ''],
    queryFn: async () => {
      const q = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/strategies/operations/timeline${q}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load timeline');
      const body = await res.json();
      return body.timeline as ActivityTimelineEntry[];
    },
    staleTime: 60_000,
  });
}

export function useAutomationSettings() {
  return useQuery({
    queryKey: ['strategy-operations-automation'],
    queryFn: async () => {
      const res = await fetch('/api/strategies/operations/automation', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load automation settings');
      const body = await res.json();
      return body as { settings: AutomationSettings; canManage: boolean };
    },
    staleTime: 120_000,
  });
}

export function useOpsInvalidation() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['strategy-operations-dashboard'] });
    qc.invalidateQueries({ queryKey: ['strategy-operations-health'] });
    qc.invalidateQueries({ queryKey: ['strategy-operations-alerts'] });
    qc.invalidateQueries({ queryKey: ['strategy-operations-timeline'] });
  };
}
