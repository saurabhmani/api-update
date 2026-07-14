// ════════════════════════════════════════════════════════════════
//  Corporate-action policy (Phase 1.3)
//
//  Signals/backtests must use a consistent adjusted OR unadjusted
//  series — never mixed. Unexplained split-like discontinuities
//  block Fibonacci and market-structure strategies (no auto-correct).
// ════════════════════════════════════════════════════════════════

import type { IntegrityIssue } from '@/lib/marketData/integrity/marketDataIntegrity';
import type { StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import type {
  CorporateActionSnapshotFields,
  PriceAdjustmentMode,
} from './canonicalInputSnapshot';

export const CORPORATE_ACTION_ADJUSTMENT_VERSION = '1.0.0';

/** Strategies blocked when unexplained discontinuity is present. */
export const STRUCTURE_SENSITIVE_STRATEGIES: ReadonlySet<StrategyName> = new Set([
  'fibonacci_pullback',
  'bullish_breakout',
  'range_breakout',
  'failed_breakout_reversal',
  'bearish_breakdown',
  'volatility_squeeze_breakout',
]);

export function resolvePriceAdjustmentMode(
  envMode: string | undefined = process.env.PRICE_ADJUSTMENT_MODE,
): PriceAdjustmentMode {
  const raw = (envMode ?? 'adjusted').trim().toLowerCase();
  if (raw === 'unadjusted') return 'unadjusted';
  if (raw === 'adjusted') return 'adjusted';
  return 'unknown';
}

export function buildCorporateActionFields(
  issues: IntegrityIssue[],
  opts: {
    mode?: PriceAdjustmentMode;
    source?: string;
    version?: string;
  } = {},
): CorporateActionSnapshotFields {
  const detected = issues.some((i) => i.code === 'SPLIT_ANOMALY');
  return {
    price_adjustment_mode:     opts.mode ?? resolvePriceAdjustmentMode(),
    corporate_action_detected: detected,
    adjustment_source:         opts.source ?? 'integrity:SPLIT_ANOMALY',
    adjustment_version:        opts.version ?? CORPORATE_ACTION_ADJUSTMENT_VERSION,
    unexplained_discontinuity: detected,
  };
}

export function isStructureStrategyBlocked(
  strategy: StrategyName,
  corporate: CorporateActionSnapshotFields,
): boolean {
  return corporate.unexplained_discontinuity
    && STRUCTURE_SENSITIVE_STRATEGIES.has(strategy);
}

export function corporateActionBlockReason(strategy: StrategyName): string {
  return (
    `Corporate-action guard: unexplained split-like discontinuity blocks ` +
    `structure/Fibonacci strategy '${strategy}' (no auto-correction)`
  );
}
