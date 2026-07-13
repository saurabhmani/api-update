// ════════════════════════════════════════════════════════════════
//  Phase 5 — Production Health Service
// ════════════════════════════════════════════════════════════════

import type {
  ComponentHealth,
  ComponentStatus,
  DependencyHealth,
  ProductionHealthSummary,
} from './types';
import { OPERATIONS_SCHEMA_VERSION } from './types';

export interface HealthProbeInput {
  generatedAt: string;
  marketData?: {
    latencyMs: number | null;
    lastCandleAt: string | null;
    candleCount: number;
    status: ComponentStatus;
  };
  scheduler?: {
    jobs: Array<{ name: string; status: string; durationMs: number; runAt: string }>;
    status: ComponentStatus;
  };
  signalGeneration?: {
    lastRunAt: string | null;
    signalsToday: number;
    status: ComponentStatus;
  };
  adaptivePipeline?: {
    lastRunAt: string | null;
    lastStatus: string | null;
    activeParameterId: string | null;
    status: ComponentStatus;
  };
  database?: { latencyMs: number | null; status: ComponentStatus; error?: string };
  cache?: { latencyMs: number | null; status: ComponentStatus; error?: string };
  filesystem?: { reportsDirWritable: boolean; status: ComponentStatus };
  reportGeneration?: {
    lastReportAt: string | null;
    status: ComponentStatus;
  };
}

function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes('unhealthy')) return 'unhealthy';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.every((s) => s === 'unknown')) return 'unknown';
  return 'healthy';
}

function countFailures(jobs: Array<{ status: string }>): number {
  return jobs.filter((j) => j.status === 'failed').length;
}

/** Pure health summary builder — no I/O. */
export function buildProductionHealthSummary(
  input: HealthProbeInput,
  responseTimeMs = 0,
): ProductionHealthSummary {
  const components: ComponentHealth[] = [];

  if (input.marketData) {
    components.push({
      component: 'market_data',
      status: input.marketData.status,
      latencyMs: input.marketData.latencyMs,
      lastSuccessAt: input.marketData.lastCandleAt,
      failureCount24h: 0,
      message: input.marketData.candleCount > 0 ? null : 'No candle data',
      metadata: { candleCount: input.marketData.candleCount },
    });
  }

  if (input.scheduler) {
    const failures = countFailures(input.scheduler.jobs);
    components.push({
      component: 'scheduler_jobs',
      status: input.scheduler.status,
      latencyMs: input.scheduler.jobs.length > 0
        ? Math.max(...input.scheduler.jobs.map((j) => j.durationMs))
        : null,
      lastSuccessAt: input.scheduler.jobs.find((j) => j.status === 'success')?.runAt ?? null,
      failureCount24h: failures,
      message: failures > 0 ? `${failures} scheduler job(s) failed` : null,
      metadata: { jobCount: input.scheduler.jobs.length },
    });
  }

  if (input.signalGeneration) {
    components.push({
      component: 'signal_generation',
      status: input.signalGeneration.status,
      latencyMs: null,
      lastSuccessAt: input.signalGeneration.lastRunAt,
      failureCount24h: 0,
      message: null,
      metadata: { signalsToday: input.signalGeneration.signalsToday },
    });
  }

  if (input.adaptivePipeline) {
    components.push({
      component: 'adaptive_pipeline',
      status: input.adaptivePipeline.status,
      latencyMs: null,
      lastSuccessAt: input.adaptivePipeline.lastRunAt,
      failureCount24h: input.adaptivePipeline.lastStatus === 'failed' ? 1 : 0,
      message: input.adaptivePipeline.lastStatus === 'failed' ? 'Adaptive pipeline failed' : null,
      metadata: {
        activeParameterId: input.adaptivePipeline.activeParameterId,
        lastStatus: input.adaptivePipeline.lastStatus,
      },
    });
  }

  if (input.database) {
    components.push({
      component: 'database',
      status: input.database.status,
      latencyMs: input.database.latencyMs,
      lastSuccessAt: input.database.status === 'healthy' ? input.generatedAt : null,
      failureCount24h: input.database.status === 'unhealthy' ? 1 : 0,
      message: input.database.error ?? null,
      metadata: {},
    });
  }

  if (input.cache) {
    components.push({
      component: 'cache',
      status: input.cache.status,
      latencyMs: input.cache.latencyMs,
      lastSuccessAt: input.cache.status === 'healthy' ? input.generatedAt : null,
      failureCount24h: 0,
      message: input.cache.error ?? null,
      metadata: {},
    });
  }

  if (input.filesystem) {
    components.push({
      component: 'filesystem',
      status: input.filesystem.status,
      latencyMs: null,
      lastSuccessAt: input.filesystem.reportsDirWritable ? input.generatedAt : null,
      failureCount24h: 0,
      message: input.filesystem.reportsDirWritable ? null : 'Reports directory not writable',
      metadata: { reportsDirWritable: input.filesystem.reportsDirWritable },
    });
  }

  if (input.reportGeneration) {
    components.push({
      component: 'report_generation',
      status: input.reportGeneration.status,
      latencyMs: null,
      lastSuccessAt: input.reportGeneration.lastReportAt,
      failureCount24h: 0,
      message: null,
      metadata: {},
    });
  }

  const dependencies: DependencyHealth[] = [];
  if (input.database) {
    dependencies.push({
      name: 'mysql',
      status: input.database.status,
      latencyMs: input.database.latencyMs,
      message: input.database.error ?? null,
    });
  }
  if (input.cache) {
    dependencies.push({
      name: 'redis',
      status: input.cache.status,
      latencyMs: input.cache.latencyMs,
      message: input.cache.error ?? null,
    });
  }

  return {
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    overallStatus: worstStatus(components.map((c) => c.status)),
    components,
    dependencies,
    responseTimeMs,
  };
}

export function mapCheckStatus(ok: boolean, warn = false): ComponentStatus {
  if (!ok) return 'unhealthy';
  if (warn) return 'degraded';
  return 'healthy';
}
