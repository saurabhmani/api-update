// ════════════════════════════════════════════════════════════════
//  Phase 5 — Operational Dashboard Data
// ════════════════════════════════════════════════════════════════

import type { HealthProbeInput } from './productionHealthService';
import type { ComponentStatus, OperationalDashboardData } from './types';
import { getConfigurationVersions } from './productionHealthCollector';

export interface DashboardInput {
  generatedAt: string;
  health: HealthProbeInput;
  promotionHistory?: Array<{ parameterId: string; status: string; promotedAt: string | null }>;
  rejectionDistribution?: Record<string, number>;
  confidenceDistribution?: Record<string, number>;
  pipelineTimingsMs?: Record<string, number | null>;
  errorRates?: Record<string, number>;
}

export function buildOperationalDashboard(input: DashboardInput): OperationalDashboardData {
  const versions = getConfigurationVersions();
  const schedulerJobs = input.health.scheduler?.jobs.map((j) => ({
    name: j.name,
    status: j.status,
    lastRunAt: j.runAt,
    durationMs: j.durationMs,
  })) ?? [];

  return {
    generatedAt: input.generatedAt,
    signalsPerDay: input.health.signalGeneration?.signalsToday ?? 0,
    schedulerHealth: input.health.scheduler?.status ?? 'unknown',
    marketFeedLatencyMs: input.health.marketData?.latencyMs ?? null,
    learningJobs: schedulerJobs,
    promotionHistory: input.promotionHistory ?? [],
    runtimeConfigurationVersion: versions.runtimeConfigurationVersion,
    activeAdaptiveVersion: versions.activeAdaptiveVersion,
    pipelineTimingsMs: input.pipelineTimingsMs ?? Object.fromEntries(
      schedulerJobs.map((j) => [j.name, j.durationMs]),
    ),
    errorRates: input.errorRates ?? computeErrorRates(schedulerJobs),
    rejectionDistribution: input.rejectionDistribution ?? {},
    confidenceDistribution: input.confidenceDistribution ?? {},
  };
}

function computeErrorRates(
  jobs: Array<{ name: string; status: string }>,
): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const job of jobs) {
    rates[job.name] = job.status === 'failed' ? 1 : 0;
  }
  return rates;
}

export function bucketConfidenceDistribution(
  scores: readonly number[],
): Record<string, number> {
  const buckets: Record<string, number> = {
    '0-54': 0,
    '55-69': 0,
    '70-84': 0,
    '85-100': 0,
  };
  for (const score of scores) {
    if (score >= 85) buckets['85-100'] += 1;
    else if (score >= 70) buckets['70-84'] += 1;
    else if (score >= 55) buckets['55-69'] += 1;
    else buckets['0-54'] += 1;
  }
  return buckets;
}

export function aggregateRejectionDistribution(
  reasons: readonly string[],
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const reason of reasons) {
    dist[reason] = (dist[reason] ?? 0) + 1;
  }
  return dist;
}

export function deriveSchedulerHealth(
  jobs: Array<{ status: string }>,
): ComponentStatus {
  if (jobs.length === 0) return 'unknown';
  if (jobs.some((j) => j.status === 'failed')) return 'degraded';
  return 'healthy';
}
