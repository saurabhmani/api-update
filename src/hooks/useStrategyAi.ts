'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiInsightsBundle, ExecutiveSummary, SimulationResult, SummaryPeriod } from '@/lib/strategy-hub/ai/types';
import type { AnalyticsWindow } from '@/lib/strategy-hub/analytics/types';

export function useStrategyAiInsights(
  strategyId: string,
  opts: { window?: AnalyticsWindow; enabled?: boolean } = {},
) {
  const window = opts.window ?? '90D';
  return useQuery({
    queryKey: ['strategy-ai-insights', strategyId, window],
    queryFn: async () => {
      const res = await fetch(
        `/api/strategies/${strategyId}/ai/insights?window=${window}`,
        { cache: 'no-store', credentials: 'include' },
      );
      if (!res.ok) throw new Error('Failed to load AI insights');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load AI insights');
      return body as AiInsightsBundle & { ok: true };
    },
    enabled: opts.enabled !== false && !!strategyId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useHubAiRecommendations(window: AnalyticsWindow = '90D') {
  return useQuery({
    queryKey: ['hub-ai-recommendations', window],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/ai/recommendations?window=${window}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load AI recommendations');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load recommendations');
      return body;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useExecutiveAiSummary(period: SummaryPeriod = 'weekly') {
  return useQuery({
    queryKey: ['executive-ai-summary', period],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/ai/summary?period=${period}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load executive summary');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load summary');
      return body.summary as ExecutiveSummary;
    },
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });
}

export function useAiRecommendationHistory(strategyId: string) {
  return useQuery({
    queryKey: ['ai-recommendation-history', strategyId],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/${strategyId}/ai/recommendations`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load history');
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Failed to load history');
      return body.history as Array<{
        id: number;
        rec_key: string;
        status: string;
        action: string;
        applied_at: string | null;
        created_at: string;
        recommendation: import('@/lib/strategy-hub/ai/types').AiRecommendation;
      }>;
    },
    enabled: !!strategyId,
    staleTime: 30_000,
  });
}

export function useApplyAiRecommendation(strategyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (recKey: string) => {
      const res = await fetch(`/api/strategies/${strategyId}/ai/recommendations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recKey }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.message ?? body.error ?? 'Apply failed');
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['strategy-ai-insights', strategyId] });
      qc.invalidateQueries({ queryKey: ['ai-recommendation-history', strategyId] });
      qc.invalidateQueries({ queryKey: ['hub-ai-recommendations'] });
    },
  });
}

export function useOptimizationSimulation(strategyId: string) {
  return useMutation({
    mutationFn: async (params: {
      window?: AnalyticsWindow;
      minConfidence?: number | null;
      excludedRegimes?: string[];
      direction?: 'BUY' | 'SELL' | null;
      approvedOnly?: boolean;
    }) => {
      const res = await fetch(`/api/strategies/${strategyId}/ai/simulate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'Simulation failed');
      return body.simulation as SimulationResult;
    },
  });
}

export function useTriggerAiAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (job: string) => {
      const res = await fetch('/api/strategies/ai/analysis', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.message ?? body.error ?? 'Analysis failed');
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['strategy-ai-insights'] });
      qc.invalidateQueries({ queryKey: ['hub-ai-recommendations'] });
      qc.invalidateQueries({ queryKey: ['executive-ai-summary'] });
    },
  });
}
