// ════════════════════════════════════════════════════════════════
//  Strategy Engine — Phase 2
//
//  Runs all strategies against a stock's features and returns
//  the best matching candidate (or none).
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures, RelativeStrengthFeatures, StrategyName,
  StrategyCandidate, StrategyMatchResult, MarketRegimeLabel,
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
// Phase 4A — swing strategies activated in the main runner.
// Phase 4B (intraday) is registered via strategyRegistry + STRATEGY_EVALUATORS
// but deliberately NOT iterated here: its evaluators only return
// INSUFFICIENT_DATA against the EOD warehouse, and adding them would
// drown the rejection log without producing any candidates. They will
// be activated automatically the day an intraday-candle provider is wired.
import { evaluateFailedBreakoutReversal   } from '../strategies/failedBreakoutReversal';
import { evaluateBearishPullbackRejection } from '../strategies/bearishPullbackRejection';
import { evaluateVolatilitySqueezeBreakout } from '../strategies/volatilitySqueezeBreakout';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { scoreConfidenceForStrategy } from '../scoring/confidenceScorer';
import { scoreRisk } from '../scoring/riskScorer';
import { buildTradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { buildReasons } from '../explain/buildReasons';
import { buildWarnings } from '../explain/buildWarnings';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';

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
  // ── Phase 4A — swing strategies (EOD-data based) ──────────
  { name: 'failed_breakout_reversal',   evaluate: evaluateFailedBreakoutReversal   }, // SELL
  { name: 'bearish_pullback_rejection', evaluate: evaluateBearishPullbackRejection }, // SELL
  { name: 'volatility_squeeze_breakout',evaluate: evaluateVolatilitySqueezeBreakout }, // BUY
];

export interface StrategyResult {
  candidates: StrategyCandidate[];
  rejections: { strategy: StrategyName; reason: string }[];
}

// ── Regime-relax helpers ──────────────────────────────────────
// Spec "FIX REGIME REJECTION" — when the live regime is e.g. Sideways
// or Weak, the per-strategy regime gates inside each evaluator (e.g.
// momentumContinuation.ts:16's BULLISH_ALLOWED_REGIMES check) reject
// every bullish strategy unconditionally. On a 13-strategy roster
// the result is `reject_count: 13, matchedStrategies: []`.
//
// Under SIGNAL_RELAX_MODE / SIGNAL_ALLOW_ANY_REGIME we DON'T silently
// rewrite production signals. We only retry the empty-result symbol
// with each strategy's preferred regime substituted, marking the
// resulting candidate with a `regime_relaxed` warning + a confidence
// penalty so it ranks below clean-regime signals. Strict-mode behavior
// is unchanged when the env vars are not set.
const REGIME_RELAX_PENALTY = (() => {
  const raw = Number(process.env.SIGNAL_REGIME_RELAX_PENALTY);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 50) return Math.floor(raw);
  return 12;  // matches staleCandlePenaltyPct default
})();
function isRegimeRelaxEnabled(): boolean {
  return process.env.SIGNAL_RELAX_MODE === 'true'
      || process.env.SIGNAL_ALLOW_ANY_REGIME === 'true';
}
/** Return a regime the strategy explicitly accepts. Falls back to
 *  'Sideways' (the most permissive label across the registry) when
 *  the registry entry is somehow missing. */
function preferredRegimeFor(strategy: StrategyName): MarketRegimeLabel {
  const entry = STRATEGY_REGISTRY[strategy];
  const first = entry?.allowedRegimes[0];
  return first ?? ('Sideways' as MarketRegimeLabel);
}
function withRegime(features: SignalFeatures, regime: MarketRegimeLabel): SignalFeatures {
  if (features.context.marketRegime === regime) return features;
  return {
    ...features,
    context: { ...features.context, marketRegime: regime },
  };
}

/** Run a single strategy and either push a candidate or a rejection.
 *  `softPassed` set to true when the regime was substituted under
 *  relax mode — adds a warning + confidence penalty. */
function evaluateOne(
  name: StrategyName,
  evaluate: (f: SignalFeatures) => StrategyMatchResult,
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures,
  candidates: StrategyCandidate[],
  rejections: { strategy: StrategyName; reason: string }[],
  opts: { softPassed: boolean } = { softPassed: false },
): void {
  const result = evaluate(features);
  if (!result.matched) {
    rejections.push({ strategy: name, reason: result.rejectionReason || 'Not matched' });
    return;
  }

  let confidence = scoreConfidenceForStrategy(features, name, relativeStrength);
  if (opts.softPassed && REGIME_RELAX_PENALTY > 0) {
    confidence = {
      ...confidence,
      finalScore: Math.max(0, confidence.finalScore - REGIME_RELAX_PENALTY),
    };
  }
  const tradePlan = buildTradePlanForStrategy(features, name);
  const stopDistPct = features.trend.close > 0
    ? Math.abs((features.trend.close - tradePlan.stopLoss) / features.trend.close) * 100
    : 0;
  const risk = scoreRisk(features, stopDistPct);
  const reasons = buildReasons(features, name);
  const baseWarnings = buildWarnings(features, name);
  const warnings = opts.softPassed
    ? [...baseWarnings, `regime_relaxed: regime gate soft-passed under SIGNAL_RELAX_MODE — applied -${REGIME_RELAX_PENALTY} confidence penalty`]
    : baseWarnings;

  const bullishStrategies: StrategyName[] = [
    'bullish_breakout', 'bullish_pullback', 'momentum_continuation', 'gap_continuation',
  ];
  if (bullishStrategies.includes(name) && relativeStrength.rsVsIndex < -5) {
    rejections.push({ strategy: name, reason: `Weak relative strength vs index: ${relativeStrength.rsVsIndex}%` });
    return;
  }
  if (BEARISH_STRATEGIES.has(name) && relativeStrength.rsVsIndex > 5) {
    rejections.push({ strategy: name, reason: `Stock outperforming index — ${name} unlikely (rs=${relativeStrength.rsVsIndex.toFixed(1)}%)` });
    return;
  }
  if (bullishStrategies.includes(name) && relativeStrength.sectorStrengthScore < 30) {
    rejections.push({ strategy: name, reason: `Weak sector: score ${relativeStrength.sectorStrengthScore}` });
    return;
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

export function runAllStrategies(
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures,
): StrategyResult {
  const candidates: StrategyCandidate[] = [];
  const rejections: { strategy: StrategyName; reason: string }[] = [];

  for (const { name, evaluate } of STRATEGIES) {
    evaluateOne(name, evaluate, features, relativeStrength, candidates, rejections);
  }

  // ── Regime-relaxed retry (opt-in via SIGNAL_RELAX_MODE) ──────────
  // Strict pass produced no candidates AND the operator has flipped
  // SIGNAL_RELAX_MODE / SIGNAL_ALLOW_ANY_REGIME. Retry each strategy
  // whose strict rejection was a regime mismatch, with the strategy's
  // preferred regime substituted. The non-regime gates (RSI, ADX,
  // volume, EMA structure) still apply unchanged — we only neutralize
  // the regime gate. Each soft-pass produces a warning + confidence
  // penalty so callers can see/rank these distinctly.
  if (candidates.length === 0 && isRegimeRelaxEnabled()) {
    const liveRegime = features.context.marketRegime;
    const regimeRejectMatcher = /regime/i;
    const relaxRejections: { strategy: StrategyName; reason: string }[] = [];
    let softPasses = 0;
    for (const { name, evaluate } of STRATEGIES) {
      const strictRejection = rejections.find((r) => r.strategy === name);
      // Only retry strategies whose strict rejection was a regime gate.
      // RSI/ADX/volume rejections survive the retry — relaxing those
      // would break far more than what the spec asks for.
      if (!strictRejection || !regimeRejectMatcher.test(strictRejection.reason)) {
        continue;
      }
      const preferredRegime = preferredRegimeFor(name);
      const relaxedFeatures = withRegime(features, preferredRegime);
      evaluateOne(
        name, evaluate, relaxedFeatures, relativeStrength,
        candidates, relaxRejections,
        { softPassed: true },
      );
      if (candidates.find((c) => c.strategy === name)) softPasses++;
    }
    // Replace strict regime rejections with whatever the relaxed pass
    // produced (a candidate or a different rejection reason).
    for (const r of relaxRejections) {
      const idx = rejections.findIndex((x) => x.strategy === r.strategy);
      if (idx >= 0) rejections[idx] = r; else rejections.push(r);
    }
    if (softPasses > 0) {
      console.log(
        `[STRATEGY] regime-relax retry: live_regime=${liveRegime} ` +
        `soft_passes=${softPasses} candidates_after_retry=${candidates.length} ` +
        `penalty=${REGIME_RELAX_PENALTY}`,
      );
    }
  }

  // ── Fallback scoring layer ────────────────────────────────────
  // Spec "FIX ZERO SIGNALS / FALLBACK SIGNAL LAYER" — when both the
  // strict pass AND the regime-relax retry return zero candidates,
  // emit a synthetic candidate built from a 4-factor score so the
  // engine ALWAYS has SOMETHING to surface. Off by default; turn on
  // via SIGNAL_FALLBACK_SCORING=true OR SIGNAL_RELAX_MODE=true.
  //
  // Score (each factor = 1 point):
  //    rsi   > 50         → 1
  //    ema20 > ema50      → 1
  //    volume_vs_20d > 1  → 1
  //    adx   > 20         → 1
  // Confidence = 30 + score * 5 (range 30-50).
  // Direction follows RSI (>50 = long, else short).
  // Strategy slot uses ema_crossover (long) / weak_trend_breakdown
  // (short) — both have permissive allowedRegimes lists so they pass
  // the registry gate. The candidate carries a `fallback_scoring`
  // warning so the API/UI can label it distinctly.
  const fallbackEnabled =
    process.env.SIGNAL_FALLBACK_SCORING === 'true'
    || process.env.SIGNAL_RELAX_MODE === 'true';
  if (candidates.length === 0 && fallbackEnabled) {
    const rsi = features.momentum.rsi14;
    const ema20 = features.trend.ema20;
    const ema50 = features.trend.ema50;
    const volRatio = features.volume.volumeVs20dAvg;
    const adx = features.momentum.adx;
    const score =
      (Number.isFinite(rsi) && rsi > 50 ? 1 : 0) +
      (Number.isFinite(ema20) && Number.isFinite(ema50) && ema20 > ema50 ? 1 : 0) +
      (Number.isFinite(volRatio) && volRatio > 1 ? 1 : 0) +
      (Number.isFinite(adx) && adx > 20 ? 1 : 0);
    const FALLBACK_MIN_SCORE = (() => {
      const raw = Number(process.env.SIGNAL_FALLBACK_MIN_SCORE);
      if (Number.isFinite(raw) && raw >= 0 && raw <= 4) return Math.floor(raw);
      // Spec "GUARANTEE SIGNAL OUTPUT" — when DEBUG_FORCE_SIGNAL is on,
      // emit a fallback candidate for every symbol regardless of how
      // many factors aligned. The downstream force-approve cap caps
      // the number of forced rows, so this just feeds the funnel.
      //
      // GOVERNANCE HARDENING (2026-05) — DEBUG_FORCE_SIGNAL is force-
      // disabled in production. A misconfigured prod env-var was
      // previously enough to drag this floor to 0 and emit synthetic
      // candidates for the entire universe; that bypass is now blocked
      // unconditionally regardless of the env-var value.
      const debugFlag = process.env.DEBUG_FORCE_SIGNAL === 'true';
      const isProd    = String(process.env.NODE_ENV ?? '').toLowerCase() === 'production';
      if (debugFlag && !isProd) return 0;
      return 2;
    })();
    if (score >= FALLBACK_MIN_SCORE) {
      const isLong = !Number.isFinite(rsi) || rsi >= 50;
      const fallbackName: StrategyName = isLong ? 'ema_crossover' : 'weak_trend_breakdown';
      const synthFinalScore = 30 + score * 5;
      const baseConfidence = scoreConfidenceForStrategy(features, fallbackName, relativeStrength);
      const tradePlan = buildTradePlanForStrategy(features, fallbackName);
      const stopDistPct = features.trend.close > 0
        ? Math.abs((features.trend.close - tradePlan.stopLoss) / features.trend.close) * 100
        : 0;
      const risk = scoreRisk(features, stopDistPct);
      candidates.push({
        strategy: fallbackName,
        features,
        relativeStrength,
        confidence: {
          ...baseConfidence,
          finalScore: synthFinalScore,
          band: 'Watchlist',
        },
        risk,
        tradePlan,
        reasons: [
          `Fallback scoring: ${score}/4 factors aligned ` +
          `(rsi=${Number.isFinite(rsi) ? rsi.toFixed(1) : 'NaN'}, ` +
          `ema20>${ema50 ? 'ema50' : 'ema50'}=${ema20 > ema50}, ` +
          `vol_ratio=${Number.isFinite(volRatio) ? volRatio.toFixed(2) : 'NaN'}, ` +
          `adx=${Number.isFinite(adx) ? adx.toFixed(1) : 'NaN'})`,
        ],
        warnings: [
          `fallback_scoring: synthetic candidate; no strict strategy matched. ` +
          `confidence=${synthFinalScore} is below institutional calibration — review before entry.`,
        ],
      });
      console.log(
        `[STRATEGY FALLBACK] direction=${isLong ? 'long' : 'short'} ` +
        `slot=${fallbackName} score=${score}/4 confidence=${synthFinalScore}`,
      );
    }
  }

  // Sort candidates by confidence (highest first)
  candidates.sort((a, b) => b.confidence.finalScore - a.confidence.finalScore);

  // ── [STRATEGY DEBUG] Per-symbol indicator + candidate snapshot ─
  // When candidates.length === 0 we emit NO_STRATEGY upstream. That
  // shows up in the UI as "No high-confidence setup" and historically
  // the root cause is invisible — did RSI/EMA/volume fail, or was
  // every strategy's gate too tight? This block prints the four key
  // indicators plus every candidate's score and every rejection
  // bucket so ops can spot the bottleneck without re-running with
  // a debugger.
  //
  // Gated by DEBUG_STRATEGY_ENGINE=1 because a 3000-symbol universe
  // scan would otherwise flood stdout. Turn on only when diagnosing
  // NO_STRATEGY regressions.
  if (process.env.DEBUG_STRATEGY_ENGINE === '1') {
    console.log('[STRATEGY DEBUG]', {
      indicators: {
        rsi14:            round(features.momentum.rsi14, 2),
        ema20:            round(features.trend.ema20, 2),
        ema50:            round(features.trend.ema50, 2),
        ema200:           round(features.trend.ema200, 2),
        closeAbove20Ema:  features.trend.closeAbove20Ema,
        closeAbove50Ema:  features.trend.closeAbove50Ema,
        vwap:             round(features.volume.vwap, 2),
        volumeVs20dAvg:   round(features.volume.volumeVs20dAvg, 2),
        atrPct:           round(features.volatility.atrPct, 2),
        rsVsIndex:        round(relativeStrength.rsVsIndex, 2),
        sectorStrength:   round(relativeStrength.sectorStrengthScore, 1),
      },
      candidates: candidates.map((c) => ({
        strategy:   c.strategy,
        confidence: round(c.confidence.finalScore, 1),
        riskScore:  round(c.risk.totalScore, 1),
        riskBand:   c.risk.band,
      })),
      rejections: rejections.map((r) => ({
        strategy: r.strategy,
        reason:   r.reason,
      })),
      verdict:
        candidates.length === 0 ? 'NO_STRATEGY'
        : candidates.length === 1 ? `match:${candidates[0].strategy}`
        : `top:${candidates[0].strategy} (${candidates.length} candidates)`,
    });
  }

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

    // Per-symbol per-strategy trace — OFF by default (a 2000-symbol
    // scan × 3 bearish strategies = 6000 lines/scan). Turn on with
    // DEBUG_SELL_STRATEGY=1 when a specific symbol-level rejection
    // needs to be seen. Printing is gated behind the env check to
    // keep production logs clean.
    if (process.env.DEBUG_SELL_STRATEGY === '1') {
      // Symbol is not attached to SignalFeatures; the caller (Phase 3
      // scan loop) knows it and can correlate via timestamp proximity.
      console.log('[SELL STRATEGY CHECK]', {
        strategy:          name,
        rsi:               features.momentum.rsi14,
        trend:             features.trend.closeAbove50Ema
          ? 'above_50ema'
          : features.trend.closeAbove20Ema
            ? 'above_20ema'
            : 'below_emas',
        volume:            features.volume.volumeVs20dAvg,
        atr_pct:           features.volatility.atrPct,
        condition_passed:  !!cand,
        failure_reason:    rej?.reason ?? null,
      });
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

function round(n: number | null | undefined, dp: number): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
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
