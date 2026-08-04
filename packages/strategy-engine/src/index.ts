/**
 * Stable public Strategy Engine boundary.
 *
 * The implementation remains in the monolith for this milestone. Consumers
 * must import this module, allowing a later implementation move without
 * changing business callers or introducing a network hop.
 */
export {
  runAllStrategies,
  resetSellDebugAgg,
  flushSellDebugAgg,
} from '@/lib/signal-engine/strategy-engine/runStrategies';
export type {
  StrategyResult,
  StrategyRunOptions,
} from '@/lib/signal-engine/strategy-engine/runStrategies';

export { resolveConflicts } from '@/lib/signal-engine/strategy-engine/resolveConflicts';
export type { ConflictResolveExtras } from '@/lib/signal-engine/strategy-engine/resolveConflicts';

export {
  STRATEGY_REGISTRY,
  isStrategyAllowedInRegime,
  evaluateStrategyRegimeEligibility,
  deriveRegimeMatrix,
  getStrategiesForRegime,
  getStrategiesForStructuredRegime,
  getStrategyEntry,
  getStrategyDisplayName,
  getStrategyCategory,
  getStrategyEntryType,
  getStrategyDirectionLabel,
  getStrategyExplanation,
  getStrategyInvalidation,
  getStrategyMode,
  getStrategyMeta,
} from '@/lib/signal-engine/strategies/strategyRegistry';

export { scoreForStrategy } from '@/lib/signal-engine/scoring/strategyScorers';
export {
  buildTradePlan,
  buildTradePlanForStrategy,
  buildPhase3TradePlanForStrategy,
} from '@/lib/signal-engine/trade-plan/buildTradePlan';

export const STRATEGY_ENGINE_VERSION = {
  contractVersion: '1.0.0',
  implementation: 'quantorus365-monolith',
} as const;

export type * from '@contracts/strategy-engine';
