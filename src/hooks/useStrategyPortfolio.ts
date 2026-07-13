'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AllocationMethod,
  DiversificationAnalysis,
  OptimizationGoal,
  PortfolioAlert,
  PortfolioOptimizationResult,
  PortfolioRiskDashboard,
  PortfolioSimulationResult,
  PortfolioSummary,
  PortfolioWindow,
} from '@/lib/strategy-hub/portfolio/types';

export function usePortfolioSummary(window: PortfolioWindow = '90D') {
  return useQuery({
    queryKey: ['portfolio-summary', window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/portfolio/summary?window=${window}`, {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load portfolio');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed');
      return body as PortfolioSummary & { ok: true };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function usePortfolioRisk(window: PortfolioWindow = '90D', enabled = true) {
  return useQuery({
    queryKey: ['portfolio-risk', window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/portfolio/risk?window=${window}`, {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load risk');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed');
      return body.risk as PortfolioRiskDashboard;
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function usePortfolioDiversification(window: PortfolioWindow = '90D', enabled = true) {
  return useQuery({
    queryKey: ['portfolio-diversification', window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/portfolio/diversification?window=${window}`, {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load diversification');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed');
      return body.diversification as DiversificationAnalysis;
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useAllocationHistory(strategyId?: string) {
  return useQuery({
    queryKey: ['allocation-history', strategyId],
    queryFn: async () => {
      const q = strategyId ? `?strategyId=${strategyId}` : '';
      const res = await fetch(`/api/strategies/portfolio/allocation${q}`, {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load history');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed');
      return body.history;
    },
    staleTime: 30_000,
  });
}

export function usePortfolioAlerts() {
  return useQuery({
    queryKey: ['portfolio-alerts'],
    queryFn: async () => {
      const res = await fetch('/api/strategies/portfolio/alerts?status=open', {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load alerts');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed');
      return body.alerts as PortfolioAlert[];
    },
    staleTime: 30_000,
  });
}

export function useSaveAllocations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      method: AllocationMethod;
      allocations: Array<{ strategyId: string; amount?: number; pct?: number }>;
      reason?: string;
      totalCapital?: number;
    }) => {
      const res = await fetch('/api/strategies/portfolio/allocation', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.errors?.join(', ') ?? body.error ?? 'Save failed');
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] });
      qc.invalidateQueries({ queryKey: ['portfolio-risk'] });
      qc.invalidateQueries({ queryKey: ['allocation-history'] });
    },
  });
}

export function usePortfolioOptimization() {
  return useMutation({
    mutationFn: async (goal: OptimizationGoal) => {
      const res = await fetch('/api/strategies/portfolio/optimize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Optimization failed');
      return body.optimization as PortfolioOptimizationResult;
    },
  });
}

export function usePortfolioSimulation() {
  return useMutation({
    mutationFn: async (params: Record<string, unknown>) => {
      const res = await fetch('/api/strategies/portfolio/simulate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Simulation failed');
      return body.simulation as PortfolioSimulationResult;
    },
  });
}

export function usePortfolioAlertActions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action }: { id: number; action: 'acknowledge' | 'resolve' | 'refresh' }) => {
      const res = await fetch('/api/strategies/portfolio/alerts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'refresh' ? { action: 'refresh' } : { id, action }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Action failed');
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-alerts'] }),
  });
}
