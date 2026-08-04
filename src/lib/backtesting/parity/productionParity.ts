// ════════════════════════════════════════════════════════════════
//  Phase 7 — Production / backtest parity contract
//
//  Backtests must call the SAME production modules. Adapters are
//  permitted; copied formulas are not.
// ════════════════════════════════════════════════════════════════

import { buildSignalFeatures, buildSignalFeaturesDetailed } from '../../signal-engine/features/buildSignalFeatures';
import { runAllStrategies } from '@strategy-engine';
import { detectEnhancedRegime, REGIME_MODEL_VERSION } from '../../signal-engine/regime/detectMarketRegime';
import { scoreConfidenceForStrategy } from '../../signal-engine/scoring/confidenceScorer';
import { runRejectionEngine } from '../../signal-engine/core/runRejectionEngine';
import { buildTradePlanForStrategy } from '@strategy-engine';
import { generatePhase1Signals } from '../../signal-engine/pipeline/generatePhase1Signals';
import { STRATEGY_REGISTRY, evaluateStrategyRegimeEligibility } from '@strategy-engine';
import { getRuntimeSignalEngineConfig } from '../../signal-engine/adaptive/runtimeConfiguration';

export const PARITY_CONTRACT_VERSION = '7.0.0';

/**
 * Canonical production entry points that institutional backtests must use.
 * Importing through this module makes parity audits greppable.
 */
export const PRODUCTION_PARITY_MODULES = {
  featureBuilder: buildSignalFeatures,
  featureBuilderDetailed: buildSignalFeaturesDetailed,
  strategyEvaluators: runAllStrategies,
  regimeDetector: detectEnhancedRegime,
  confidenceScorer: scoreConfidenceForStrategy,
  rejectionEngine: runRejectionEngine,
  tradePlanBuilder: buildTradePlanForStrategy,
  phase1Pipeline: generatePhase1Signals,
  strategyRegistry: STRATEGY_REGISTRY,
  regimeEligibility: evaluateStrategyRegimeEligibility,
  runtimeConfig: getRuntimeSignalEngineConfig,
} as const;

export interface ParityChecklistItem {
  id: string;
  module: string;
  productionSymbol: string;
  required: boolean;
  notes: string;
}

/** Operator checklist — adapters wrap these; must not reimplement. */
export function getProductionParityChecklist(): ParityChecklistItem[] {
  return [
    {
      id: 'features',
      module: 'features/buildSignalFeatures',
      productionSymbol: 'buildSignalFeatures / buildSignalFeaturesDetailed',
      required: true,
      notes: 'Same fingerprint under identical as-of candles',
    },
    {
      id: 'strategies',
      module: 'strategy-engine/runStrategies',
      productionSymbol: 'runAllStrategies',
      required: true,
      notes: 'No duplicate evaluator logic in backtesting/',
    },
    {
      id: 'config',
      module: 'adaptive/runtimeConfiguration',
      productionSymbol: 'getRuntimeSignalEngineConfig',
      required: true,
      notes: 'Frozen walk-forward config versions must bind to this contract',
    },
    {
      id: 'regime',
      module: 'regime/detectMarketRegime',
      productionSymbol: `detectEnhancedRegime (${REGIME_MODEL_VERSION})`,
      required: true,
      notes: 'Same detector as live Product A',
    },
    {
      id: 'confidence',
      module: 'scoring/confidenceScorer',
      productionSymbol: 'scoreConfidenceForStrategy',
      required: true,
      notes: 'Identical factor ownership rules',
    },
    {
      id: 'rejection',
      module: 'core/runRejectionEngine',
      productionSymbol: 'runRejectionEngine',
      required: true,
      notes: 'Phase 3 rejection parity when executable path is used',
    },
    {
      id: 'trade_plan',
      module: 'trade-plan/buildTradePlan',
      productionSymbol: 'buildTradePlanForStrategy',
      required: true,
      notes: 'Same geometry — stop/target formulae not copied',
    },
  ];
}

/** Runtime fingerprint for reproducibility metadata. */
export function buildParityFingerprint(extra: Record<string, string> = {}): Record<string, string> {
  const cfg = getRuntimeSignalEngineConfig();
  return {
    parityContract: PARITY_CONTRACT_VERSION,
    regimeModel: REGIME_MODEL_VERSION,
    runtimeConfigVersion: String(cfg.config.version),
    ...extra,
  };
}

/** Assert all required parity symbols resolve (import-time smoke). */
export function assertProductionParityModulesLoaded(): {
  ok: boolean;
  missing: string[];
  version: string;
} {
  const missing: string[] = [];
  for (const [key, fn] of Object.entries(PRODUCTION_PARITY_MODULES)) {
    if (typeof fn !== 'function' && (typeof fn !== 'object' || fn == null)) {
      missing.push(key);
    }
  }
  return { ok: missing.length === 0, missing, version: PARITY_CONTRACT_VERSION };
}
