// ════════════════════════════════════════════════════════════════
//  pipelineMetrics — process-local counters + latency rollup for
//  every pipeline stage. Exposed via /api/pipeline/stats.
//
//  Intentionally in-memory and globalThis-backed so that multiple
//  route handlers and worker loops inside the same Node process
//  share the same counters. Separate worker processes expose their
//  own counters via their own /stats endpoint (or write them to
//  Redis HASH keys if you want cross-process aggregation).
// ════════════════════════════════════════════════════════════════

export interface StageMetrics {
  processed: number;
  errors:    number;
  lastTs:    number | null;
  lastError: string | null;
  /** Sum of per-entry processing latency in ms; divide by processed for avg. */
  latSumMs:  number;
  latMaxMs:  number;
}

export type StageName = 'publisher' | 'strategy' | 'execution';

interface MetricsState {
  stages: Record<StageName, StageMetrics>;
}

const GLOBAL_KEY = '__q365_pipeline_metrics__';

function blank(): StageMetrics {
  return {
    processed: 0,
    errors:    0,
    lastTs:    null,
    lastError: null,
    latSumMs:  0,
    latMaxMs:  0,
  };
}

function getState(): MetricsState {
  const g = globalThis as unknown as Record<string, MetricsState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      stages: {
        publisher: blank(),
        strategy:  blank(),
        execution: blank(),
      },
    };
  }
  return g[GLOBAL_KEY]!;
}

export function recordProcessed(stage: StageName, latencyMs: number): void {
  const m = getState().stages[stage];
  m.processed += 1;
  m.lastTs     = Date.now();
  m.latSumMs  += latencyMs;
  if (latencyMs > m.latMaxMs) m.latMaxMs = latencyMs;
}

export function recordError(stage: StageName, err: Error): void {
  const m = getState().stages[stage];
  m.errors    += 1;
  m.lastError  = err.message;
}

export function snapshotMetrics(): {
  stages: Record<StageName, StageMetrics & { avgLatMs: number }>;
} {
  const s = getState();
  const out = {} as Record<StageName, StageMetrics & { avgLatMs: number }>;
  (Object.keys(s.stages) as StageName[]).forEach((k) => {
    const m = s.stages[k];
    out[k] = { ...m, avgLatMs: m.processed > 0 ? m.latSumMs / m.processed : 0 };
  });
  return { stages: out };
}
