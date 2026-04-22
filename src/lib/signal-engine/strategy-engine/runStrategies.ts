// ════════════════════════════════════════════════════════════════
//  Strategy Engine — Phase 2
//
//  Runs all strategies against a stock's features and returns
//  the best matching candidate (or none).
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures, RelativeStrengthFeatures, StrategyName,
  StrategyCandidate, StrategyMatchResult,
} from '../types/signalEngine.types';
import { evaluateBullishBreakout } from '../strategies/bullishBreakout';
import { evaluateBullishPullback } from '../strategies/bullishPullback';
import { evaluateBearishBreakdown } from '../strategies/bearishBreakdown';
import { evaluateMeanReversionBounce } from '../strategies/meanReversionBounce';
import { evaluateMomentumContinuation } from '../strategies/momentumContinuation';
import { evaluateBullishDivergence } from '../strategies/bullishDivergence';
import { evaluateVolumeClimaxReversal } from '../strategies/volumeClimaxReversal';
import { evaluateGapContinuation } from '../strategies/gapContinuation';
import { evaluateRangeBreakout } from '../strategies/rangeBreakout';
import { evaluateEmaCrossover } from '../strategies/emaCrossover';
import { evaluateOversoldBounce } from '../strategies/oversoldBounce';
import { evaluateOverboughtReversal } from '../strategies/overboughtReversal';
import { evaluateWeakTrendBreakdown } from '../strategies/weakTrendBreakdown';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { scoreConfidenceForStrategy } from '../scoring/confidenceScorer';
import { scoreRisk } from '../scoring/riskScorer';
import { buildTradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { buildReasons } from '../explain/buildReasons';
import { buildWarnings } from '../explain/buildWarnings';

interface StrategyEntry {
  name: StrategyName;
  evaluate: (f: SignalFeatures) => StrategyMatchResult;
}

const STRATEGIES: StrategyEntry[] = [
  { name: 'bullish_breakout',       evaluate: (f) => evaluateBullishBreakout(f) },
  { name: 'momentum_continuation',  evaluate: evaluateMomentumContinuation },
  { name: 'gap_continuation',       evaluate: evaluateGapContinuation },
  { name: 'bullish_pullback',       evaluate: evaluateBullishPullback },
  { name: 'bearish_breakdown',      evaluate: evaluateBearishBreakdown },
  { name: 'overbought_reversal',    evaluate: evaluateOverboughtReversal   },   // SELL
  { name: 'weak_trend_breakdown',   evaluate: evaluateWeakTrendBreakdown   },   // SELL
  { name: 'mean_reversion_bounce',  evaluate: evaluateMeanReversionBounce },
  { name: 'bullish_divergence',     evaluate: evaluateBullishDivergence },
  { name: 'volume_climax_reversal', evaluate: evaluateVolumeClimaxReversal },
  { name: 'range_breakout',         evaluate: evaluateRangeBreakout },
  { name: 'ema_crossover',          evaluate: evaluateEmaCrossover },
  { name: 'oversold_bounce',        evaluate: evaluateOversoldBounce },
];

export interface StrategyResult {
  candidates: StrategyCandidate[];
  rejections: { strategy: StrategyName; reason: string }[];
}

export function runAllStrategies(
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures,
): StrategyResult {
  const candidates: StrategyCandidate[] = [];
  const rejections: { strategy: StrategyName; reason: string }[] = [];

  for (const { name, evaluate } of STRATEGIES) {
    const result = evaluate(features);
    if (!result.matched) {
      rejections.push({ strategy: name, reason: result.rejectionReason || 'Not matched' });
      continue;
    }

    // Strategy matched — score it
    const confidence = scoreConfidenceForStrategy(features, name, relativeStrength);
    const tradePlan = buildTradePlanForStrategy(features, name);
    const stopDistPct = features.trend.close > 0
      ? Math.abs((features.trend.close - tradePlan.stopLoss) / features.trend.close) * 100
      : 0;
    const risk = scoreRisk(features, stopDistPct);
    const reasons = buildReasons(features, name);
    const warnings = buildWarnings(features, name);

    // Apply relative strength rejection for bullish strategies
    const bullishStrategies: StrategyName[] = [
      'bullish_breakout', 'bullish_pullback', 'momentum_continuation', 'gap_continuation',
    ];
    if (bullishStrategies.includes(name) && relativeStrength.rsVsIndex < -5) {
      rejections.push({ strategy: name, reason: `Weak relative strength vs index: ${relativeStrength.rsVsIndex}%` });
      continue;
    }
    // Symmetric with the bullish rejection on line 81 (`rsVsIndex < -5`).
    // Covers ALL bearish strategies via the shared BEARISH_STRATEGIES
    // Set — without this, overbought_reversal + weak_trend_breakdown
    // would skip the rs filter and happily generate SELL signals on
    // stocks that are outperforming the tape by 10%+.
    if (BEARISH_STRATEGIES.has(name) && relativeStrength.rsVsIndex > 5) {
      rejections.push({ strategy: name, reason: `Stock outperforming index — ${name} unlikely (rs=${relativeStrength.rsVsIndex.toFixed(1)}%)` });
      continue;
    }

    // Sector weakness rejection for longs
    if (bullishStrategies.includes(name) && relativeStrength.sectorStrengthScore < 30) {
      rejections.push({ strategy: name, reason: `Weak sector: score ${relativeStrength.sectorStrengthScore}` });
      continue;
    }

    candidates.push({
      strategy: name,
      features,
      relativeStrength,
      confidence,
      risk,
      tradePlan,
      reasons,
      warnings,
    });
  }

  // Sort candidates by confidence (highest first)
  candidates.sort((a, b) => b.confidence.finalScore - a.confidence.finalScore);

  // ── [SELL DEBUG] per-symbol generation log ───────────────────
  // Fires every evaluation so operators can tell whether SELL
  // candidates are being rejected at the strategy layer, or
  // whether bearishBreakdown simply isn't matching. Rolls up
  // across 2943-symbol scans via a module-level counter (reset
  // each time Phase 3 kicks off).
  //
  // Grep target: `[SELL DEBUG]` (symbol-level),
  //              `[SELL DEBUG AGG]` (batch summary, flushed
  //               from Phase 3 entry point).
  // Track ALL bearish strategies — the aggregator is "how many
  // SELL candidates did we generate?", not "how many did bearish_
  // breakdown specifically emit?". Matches are counted once per
  // bearish strategy that fired; rejections are bucketed by reason
  // so overbought_reversal failing for "rsi_too_strong" is visible
  // separately from bearish_breakdown failing for "no_support_break".
  for (const name of BEARISH_STRATEGIES) {
    const cand = candidates.find((c) => c.strategy === name);
    const rej  = rejections.find((r) => r.strategy === name);
    if (cand) {
      _sellDebugAgg.matched++;
      _sellDebugAgg.byStrategy[name] = (_sellDebugAgg.byStrategy[name] ?? 0) + 1;
    } else if (rej) {
      _sellDebugAgg.rejected++;
      const bucket = _bucketReason(rej.reason);
      _sellDebugAgg.reasons[bucket] = (_sellDebugAgg.reasons[bucket] ?? 0) + 1;
    }
  }

  return { candidates, rejections };
}

// ── SELL generation diagnostics ─────────────────────────────────
//
// Module-level aggregator so Phase 3 can flush a single [SELL
// DEBUG AGG] block after the full universe scan rather than
// spamming 2943 per-symbol lines. Call resetSellDebugAgg() before
// a batch and flushSellDebugAgg() after — both safe to no-op if
// no caller wires them.
interface SellDebugAgg {
  matched:  number;
  rejected: number;
  reasons:  Record<string, number>;
  byStrategy: Record<string, number>;   // per-strategy match counts
}
const _sellDebugAgg: SellDebugAgg = { matched: 0, rejected: 0, reasons: {}, byStrategy: {} };

function _bucketReason(raw: string): string {
  // Compress the specific rejection message into a stable bucket
  // key so the aggregate counter rolls up cleanly.
  const m = raw.toLowerCase();
  if (m.includes('liquidity')) return 'liquidity';
  if (m.includes('strong bullish')) return 'strong_bull_regime';
  if (m.includes('20-day support')) return 'no_support_break';
  if (m.includes('above both emas')) return 'above_emas';
  if (m.includes('rsi too strong')) return 'rsi_too_strong';
  if (m.includes('macd histogram positive')) return 'macd_positive';
  if (m.includes('volume too low')) return 'volume_too_low';
  if (m.includes('atr% extreme')) return 'atr_extreme';
  if (m.includes('breakdown already too deep')) return 'breakdown_too_deep';
  if (m.includes('outperforming index')) return 'rs_outperforming';
  return 'other';
}

export function resetSellDebugAgg(): void {
  _sellDebugAgg.matched    = 0;
  _sellDebugAgg.rejected   = 0;
  _sellDebugAgg.reasons    = {};
  _sellDebugAgg.byStrategy = {};
}

export function flushSellDebugAgg(): SellDebugAgg {
  const snap: SellDebugAgg = {
    matched:    _sellDebugAgg.matched,
    rejected:   _sellDebugAgg.rejected,
    reasons:    { ..._sellDebugAgg.reasons },
    byStrategy: { ..._sellDebugAgg.byStrategy },
  };
  console.log('[SELL DEBUG AGG]', {
    matched:           snap.matched,
    rejected:          snap.rejected,
    total_evaluated:   snap.matched + snap.rejected,
    by_strategy:       snap.byStrategy,
    rejection_reasons: snap.reasons,
    hint:
      snap.matched + snap.rejected === 0 ? 'Strategy never evaluated — check pipeline wiring.' :
      snap.matched === 0                 ? 'Zero SELL matches across all three bearish strategies. Top rejection bucket above is the bottleneck.' :
      snap.matched < 5                   ? 'Few SELL matches — market may genuinely be bullish, or a gate is too tight.' :
      'Healthy SELL generation.',
  });
  return snap;
}
