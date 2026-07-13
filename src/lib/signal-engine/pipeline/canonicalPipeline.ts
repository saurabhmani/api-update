// ════════════════════════════════════════════════════════════════
//  Canonical Product A pipeline — entry-point registry (Phase 1)
//
//  Production actionable signals MUST enter via generatePhase4Signals.
//  Deprecated paths are listed for audit; they must not publish to
//  the Manual Signal UI without the canonical enrichment chain.
// ════════════════════════════════════════════════════════════════

/** Ordered stages — see docs/product-a/architecture.md */
export const CANONICAL_PIPELINE_STAGES = [
  'marketDataResolver',
  'feature_builder',
  'strategy_matcher',
  'setup_confidence',
  'trade_plan',
  'phase3_rejection_gate',
  'phase4_enrichment',
  'confirmation',
  'api_serialization',
  'manual_signal_ui',
  'outcome_tracking',
] as const;

export type CanonicalPipelineStage = typeof CANONICAL_PIPELINE_STAGES[number];

/** Production entry points allowed to run the full Product A pipeline. */
export const CANONICAL_GENERATION_ENTRY_POINTS = [
  'src/lib/workers/scheduler.ts',
  'src/lib/workers/dailyScanSchedule.ts',
  'src/lib/workers/bootInProc.ts',
  'src/app/api/run-signal-engine/route.ts',
  'src/app/api/signals/route.ts',
  'scripts/validateSignalEngineFunctional.ts',
] as const;

/**
 * Alternate paths that must NOT publish actionable Product A signals.
 * Scanner / Phase-1-only / legacy APIs are debug or deprecated.
 */
export const DEPRECATED_SIGNAL_ENTRY_POINTS: ReadonlyArray<{
  module: string;
  reason: string;
}> = [
  {
    module: 'src/lib/scanner/customUniverseBatchScanner.ts',
    reason: 'Parallel Yahoo scanner — tags generation_source=scanner:custom-universe:yahoo',
  },
  {
    module: 'src/app/api/signal-engine/route.ts',
    reason: 'Phase 1/2 debug API — use generatePhase4Signals for production',
  },
  {
    module: 'src/lib/signal-engine/live/analyzeInstrument.ts',
    reason: 'Per-symbol live revalidation only — not batch publisher',
  },
  {
    module: 'src/lib/backtesting/runner/backtestRunner.ts',
    reason: 'Backtest replay — historical, not live UI publisher',
  },
];

/** True when generation_source is from the canonical Phase-4 pipeline. */
export function isCanonicalGenerationSource(source: string | null | undefined): boolean {
  const s = String(source ?? '').toLowerCase();
  if (!s) return false;
  if (s.includes('scanner:custom-universe')) return false;
  if (s.includes('backtest')) return false;
  return (
    s.includes('generatephase4') ||
    s.includes('signal-engine:generatephase4') ||
    s.includes('validate:signal-engine') ||
    s.includes('daily-scan') ||
    s.includes('scheduler') ||
    s.includes('run-signal-engine') ||
    s.includes('inproc')
  );
}
