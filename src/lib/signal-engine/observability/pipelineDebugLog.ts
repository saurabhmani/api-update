// ════════════════════════════════════════════════════════════════
//  Pipeline debug logging — Phase 1 observability
//
//  Structured, debug-only logs for signal pipeline stages.
//  Enable: PIPELINE_DEBUG=1  (or true/on)
//  No output in production unless explicitly enabled.
// ════════════════════════════════════════════════════════════════

export type PipelineStage =
  | 'market_data'
  | 'feature_build'
  | 'strategy_match'
  | 'setup_confidence'
  | 'trade_plan'
  | 'phase3_gate'
  | 'phase4_enrichment'
  | 'confirmation'
  | 'api_serialization'
  | 'outcome_tracking';

export interface PipelineDebugPayload {
  stage:             PipelineStage;
  symbol?:           string;
  strategy?:         string;
  confidence?:       number;
  rejection_reason?: string | null;
  duration_ms?:      number;
  data_source?:      string | null;
  run_id?:           string;
  extra?:            Record<string, string | number | boolean | null>;
}

function isEnabled(): boolean {
  const v = String(process.env.PIPELINE_DEBUG ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Emit one JSON line to stderr when PIPELINE_DEBUG is enabled.
 * Uses stderr so Next.js stdout stays clean for operators.
 */
export function pipelineDebugLog(payload: PipelineDebugPayload): void {
  if (!isEnabled()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: 'pipeline_debug',
    ...payload,
  });
  process.stderr.write(line + '\n');
}

/** Time a stage and log duration on completion. */
export function pipelineDebugSpan<T>(
  payload: Omit<PipelineDebugPayload, 'duration_ms'>,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!isEnabled()) return Promise.resolve(fn()) as Promise<T>;
  const t0 = Date.now();
  const finish = (extra?: Partial<PipelineDebugPayload>) => {
    pipelineDebugLog({
      ...payload,
      ...extra,
      stage: extra?.stage ?? payload.stage,
      duration_ms: Date.now() - t0,
    } as PipelineDebugPayload);
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then((v) => { finish(); return v; }).catch((err) => {
        finish({ rejection_reason: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }
    finish();
    return Promise.resolve(result);
  } catch (err) {
    finish({ rejection_reason: err instanceof Error ? (err as Error).message : String(err) });
    throw err;
  }
}
