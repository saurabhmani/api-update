// ════════════════════════════════════════════════════════════════
//  Engine Version — single source of truth for provenance fields.
//
//  Every row written to q365_signals by the phase-based engine
//  records these values so we can later prove which code path
//  produced which signal. Bump ENGINE_VERSION whenever generation
//  logic (strategies, scoring, trade-plan math) changes in a way
//  that affects what the engine would produce for the same inputs.
//
//  `generation_source` is *not* a constant — it's set per caller
//  (e.g. 'api:signal-engine:generate-v1', 'api:run-signal-engine',
//  'backtest:replay') so we can attribute rows to the entry point.
// ════════════════════════════════════════════════════════════════

export const ENGINE_PHASE = 'phase1';
export const ENGINE_VERSION = '1.0.0';
export const CODE_BUILD = process.env.CODE_BUILD ?? process.env.GIT_SHA ?? 'dev';

export interface EngineProvenance {
  engine_phase: string;
  engine_version: string;
  generation_source: string;
  code_build: string;
}

export function makeProvenance(generationSource: string): EngineProvenance {
  return {
    engine_phase: ENGINE_PHASE,
    engine_version: ENGINE_VERSION,
    generation_source: generationSource,
    code_build: CODE_BUILD,
  };
}
