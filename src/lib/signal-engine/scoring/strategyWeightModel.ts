// ════════════════════════════════════════════════════════════════
//  Strategy Weight Model
//
//  Per-strategy weight presets for the scoring engine. Different
//  strategy families care about different dimensions — a breakout
//  lives and dies on freshness + clean R:R, a mean-reversion trade
//  lives and dies on risk quality. Applying a one-size-fits-all
//  weight vector undersells the specialist strategies.
//
//  This file maps every StrategyName to one of four categories —
//  breakout, pullback, momentum, mean_reversion — and exposes a
//  tuned ScoringWeights preset per category. The scoring engine
//  then composes per-strategy finalScore via:
//
//      computeFinalScore(input, getStrategyWeights(candidate.strategy))
//
//  Category choice rationale:
//
//    breakout        — freshness matters most (stale breakouts fail);
//                      R:R matters (clean targets once the level
//                      breaks); regime carries less weight because
//                      breakouts frequently happen AT regime turns.
//
//    pullback        — regime alignment + confidence dominate; you
//                      need the trend intact for a pullback to work.
//                      R:R is usually modest, so its weight drops.
//
//    momentum        — confidence + regime + freshness carry the
//                      bulk of the weight; momentum decays quickly
//                      and demands an aligned tape. Portfolio fit
//                      is opportunistic, so it drops slightly.
//
//    mean_reversion  — risk quality matters most (contrarian trades
//                      are structurally riskier); regime alignment
//                      weight drops because MR intentionally fights
//                      the tape; confidence weight drops slightly
//                      because MR setups are weaker by nature.
//
//  All weight presets sum to exactly 1.0 — validated at module load.
// ════════════════════════════════════════════════════════════════

import type { StrategyName } from '../types/signalEngine.types';
import type { ScoringWeights } from './scoringEngine';
import { DEFAULT_SCORING_WEIGHTS } from './scoringEngine';

// ── Category taxonomy ───────────────────────────────────────────

export type StrategyCategory =
  | 'breakout'
  | 'pullback'
  | 'momentum'
  | 'mean_reversion';

/**
 * Every StrategyName maps to exactly one category. Keep this in
 * sync with `types/signalEngine.types.ts:StrategyName` — the
 * compiler enforces that every union member is covered (adding a
 * strategy there without adding a mapping here is a type error).
 */
export const STRATEGY_CATEGORY_MAP: Record<StrategyName, StrategyCategory> = {
  // Breakouts — range expansion, gap continuation, breakdown all
  // share the same "level has broken, ride it" DNA.
  bullish_breakout:       'breakout',
  bearish_breakdown:      'breakout',
  range_breakout:         'breakout',
  gap_continuation:       'breakout',

  // Pullbacks — a single strategy today, kept as its own category
  // because the weight profile is meaningfully different from
  // momentum (lower R:R weight, higher regime weight).
  bullish_pullback:       'pullback',

  // Momentum — continuation trades riding an already-established
  // move. EMA crossover + weak-trend breakdown sit here because
  // both are "trend is strengthening" setups rather than "level is
  // breaking" (breakout) or "trend is reversing" (mean reversion).
  momentum_continuation:  'momentum',
  ema_crossover:          'momentum',
  weak_trend_breakdown:   'momentum',

  // Mean reversion — anything that enters AGAINST the immediate
  // move expecting a snap-back. Bounce, oversold, overbought,
  // divergence, and climax reversal all share the contrarian
  // profile even when the label doesn't say "mean_reversion".
  mean_reversion_bounce:  'mean_reversion',
  oversold_bounce:        'mean_reversion',
  overbought_reversal:    'mean_reversion',
  bullish_divergence:     'mean_reversion',
  volume_climax_reversal: 'mean_reversion',

  // Phase 4 additions — categorised so existing weight presets apply.
  failed_breakout_reversal:    'mean_reversion',     // contrarian reversal — same DNA as the others
  bearish_pullback_rejection:  'breakout',           // continuation-short, breakdown family
  volatility_squeeze_breakout: 'breakout',
  multi_timeframe_alignment:   'momentum',           // confirmation only — momentum weights are the safer default
  vwap_reclaim_long:           'momentum',
  vwap_rejection_short:        'mean_reversion',
  opening_range_breakout:      'breakout',
  opening_range_breakdown:     'breakout',
};

// ── Per-category weight presets ─────────────────────────────────
//
// Each row sums to 1.0. Changes here propagate to every caller of
// `getStrategyWeights(...)` — there is no per-symbol override.
//
// Reference baseline (DEFAULT_SCORING_WEIGHTS in scoringEngine.ts):
//   confidence 0.35, riskQuality 0.20, rewardRisk 0.15,
//   portfolioFit 0.10, regimeAlignment 0.10, freshness 0.10.
export const STRATEGY_CATEGORY_WEIGHTS: Record<StrategyCategory, ScoringWeights> = {
  breakout: {
    confidence:      0.30,  // slightly less — pattern is the trade
    riskQuality:     0.15,
    rewardRisk:      0.20,  // UP — targets are cleanest post-breakout
    portfolioFit:    0.10,
    regimeAlignment: 0.10,
    freshness:       0.15,  // UP — stale breakouts routinely fail
  },

  pullback: {
    confidence:      0.35,
    riskQuality:     0.20,
    rewardRisk:      0.10,  // DOWN — reward usually modest in-trend
    portfolioFit:    0.10,
    regimeAlignment: 0.15,  // UP — needs the parent trend intact
    freshness:       0.10,
  },

  momentum: {
    confidence:      0.35,
    riskQuality:     0.15,
    rewardRisk:      0.15,
    portfolioFit:    0.05,  // DOWN — momentum is opportunistic
    regimeAlignment: 0.15,  // UP — needs an aligned tape
    freshness:       0.15,  // UP — momentum decays fast
  },

  mean_reversion: {
    confidence:      0.30,  // DOWN — MR setups are weaker by nature
    riskQuality:     0.30,  // UP — contrarian trades are riskier
    rewardRisk:      0.15,
    portfolioFit:    0.10,
    regimeAlignment: 0.05,  // DOWN — MR intentionally fights the tape
    freshness:       0.10,
  },
};

// ── Validation — weights MUST sum to 1.0 ────────────────────────
//
// Runs once at module load. A drift bug here would produce scores
// that silently slide outside [0, 100], so fail loudly and early.
(function validateWeights(): void {
  for (const [category, w] of Object.entries(STRATEGY_CATEGORY_WEIGHTS)) {
    const sum =
      w.confidence + w.riskQuality + w.rewardRisk +
      w.portfolioFit + w.regimeAlignment + w.freshness;
    if (Math.abs(sum - 1) > 1e-6) {
      throw new Error(
        `[strategyWeightModel] weights for "${category}" sum to ${sum}, expected 1.0`,
      );
    }
  }
})();

// ── Public API ──────────────────────────────────────────────────

/**
 * Return the strategy category for a given strategy name.
 * Unknown names return 'momentum' as a safe fallback — the
 * compiler prevents this at callsites, but the runtime default
 * keeps a future additions from crashing before they're wired in.
 */
export function getStrategyCategory(strategyName: StrategyName): StrategyCategory {
  return STRATEGY_CATEGORY_MAP[strategyName] ?? 'momentum';
}

/**
 * Return the tuned ScoringWeights for a given strategy. Pass the
 * result into `computeFinalScore(input, weights)`.
 *
 * Unknown names fall through to DEFAULT_SCORING_WEIGHTS — the
 * scorer would normalize regardless, but returning the documented
 * defaults keeps downstream debug logs honest.
 */
export function getStrategyWeights(strategyName: StrategyName): ScoringWeights {
  const category = STRATEGY_CATEGORY_MAP[strategyName];
  if (!category) return DEFAULT_SCORING_WEIGHTS;
  return STRATEGY_CATEGORY_WEIGHTS[category];
}

// ════════════════════════════════════════════════════════════════
//  Phase-3 Per-Strategy Factor Weights
// ════════════════════════════════════════════════════════════════
//
//  Companion to Phase-2 calculateFinalScore (in scoringEngine.ts).
//  Both are intentionally NOT wired into any caller yet — Phase-3
//  deliverable is the lookup function itself; integration is a
//  later phase per the spec.
//
//  Why a second weight scheme:
//    The legacy `getStrategyWeights` above returns the 6-component
//    `ScoringWeights` object that `computeFinalScore` consumes. The
//    new Phase-2 `calculateFinalScore` uses an 8-factor scheme
//    (strategy_quality, trend_alignment, momentum, volume_
//    confirmation, risk_reward, liquidity, market_regime,
//    portfolio_fit) plus an optional 9th factor `support_strength`
//    that only mean-reversion setups care about. The two schemes
//    are not interchangeable, so they live side-by-side until the
//    integration phase retires the legacy one.
//
//  Per-strategy weights (point totals ≈ 100 BEFORE penalties):
//    bullish_breakout       — Strategy Quality 25, Volume 20, Trend 15,
//                             Momentum 10, R:R 15, Regime 10, Fit 5
//    bullish_pullback       — Trend 25, R:R 20, Strategy 15, Fit 15,
//                             Momentum 10, Liquidity 10, Volume 5
//    momentum_continuation  — Momentum 25, Trend 20, Volume 20,
//                             Strategy 15, R:R 10, Regime 5, Fit 5
//    mean_reversion_bounce  — R:R 25, Strategy 20, Momentum 15,
//                             Support 15, Liquidity 10, Fit 10, Regime 5
//    bearish_breakdown      — Strategy 25, Volume 20, Trend 20,
//                             Momentum 15, R:R 10, Regime 5, Fit 5
//
//  Default (any unrecognised name) — strategy_quality 20,
//    trend_alignment 15, momentum 10, volume_confirmation 10,
//    risk_reward 15, liquidity 10, market_regime 10, portfolio_fit 10.

/** All factor names that any preset may carry. Mean-reversion is
 *  the only family that uses `support_strength`; every other
 *  strategy preset maps to a subset of the first eight. */
export type StrategyFactorName =
  | 'strategy_quality'
  | 'volume_confirmation'
  | 'trend_alignment'
  | 'momentum'
  | 'risk_reward'
  | 'market_regime'
  | 'portfolio_fit'
  | 'liquidity'
  | 'support_strength';

/** A weight preset is a partial map — factors omitted from a preset
 *  do not contribute to that strategy's score. */
export type StrategyFactorWeights = Partial<Record<StrategyFactorName, number>>;

export interface StrategyWeightLookupResult {
  /** Normalized strategy key actually looked up (e.g. 'bullish_breakout'). */
  strategy: string;
  /** The weight preset for that strategy (or default fallback). */
  weights:  StrategyFactorWeights;
  /** Sum of all weight values — should be ≈ 100. */
  total:    number;
  /** Was the preset specifically defined, or did we fall back? */
  source:   'preset' | 'default';
}

/** Default weight preset — used when the requested strategy has no
 *  named entry in the preset map. Sums to 100. Mirrors the eight
 *  Phase-2 factors of calculateFinalScore. */
export const DEFAULT_STRATEGY_FACTOR_WEIGHTS: Readonly<StrategyFactorWeights> = Object.freeze({
  strategy_quality:    20,
  trend_alignment:     15,
  momentum:            10,
  volume_confirmation: 10,
  risk_reward:         15,
  liquidity:           10,
  market_regime:       10,
  portfolio_fit:       10,
});

/** Per-strategy presets. Keys MUST be the canonical
 *  snake_case strategy id from `StrategyName`; the public lookup
 *  normalizes friendly names ("Bullish Breakout") to that form. */
export const STRATEGY_FACTOR_WEIGHT_PRESETS: Readonly<Record<string, StrategyFactorWeights>> = Object.freeze({
  bullish_breakout: {
    strategy_quality:    25,
    volume_confirmation: 20,
    trend_alignment:     15,
    momentum:            10,
    risk_reward:         15,
    market_regime:       10,
    portfolio_fit:        5,
  },
  bullish_pullback: {
    trend_alignment:     25,
    risk_reward:         20,
    strategy_quality:    15,
    portfolio_fit:       15,
    momentum:            10,
    liquidity:           10,
    volume_confirmation:  5,
  },
  momentum_continuation: {
    momentum:            25,
    trend_alignment:     20,
    volume_confirmation: 20,
    strategy_quality:    15,
    risk_reward:         10,
    market_regime:        5,
    portfolio_fit:        5,
  },
  mean_reversion_bounce: {
    risk_reward:         25,
    strategy_quality:    20,
    momentum:            15,
    support_strength:    15,
    liquidity:           10,
    portfolio_fit:       10,
    market_regime:        5,
  },
  bearish_breakdown: {
    strategy_quality:    25,
    volume_confirmation: 20,
    trend_alignment:     20,
    momentum:            15,
    risk_reward:         10,
    market_regime:        5,
    portfolio_fit:        5,
  },
});

/** Sum the values of a (partial) factor-weight record. Undefined
 *  factors contribute zero. */
export function sumStrategyFactorWeights(w: StrategyFactorWeights): number {
  let s = 0;
  for (const v of Object.values(w)) {
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return Math.round(s * 100) / 100;
}

/** Normalize a free-form strategy label to the canonical key:
 *    "Bullish Breakout"  → "bullish_breakout"
 *    "BULLISH-BREAKOUT"  → "bullish_breakout"
 *    "  bullish_breakout " → "bullish_breakout"           */
function normalizeStrategyKey(name: string): string {
  return String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Phase-3 entry point — look up the per-strategy factor weights
 * for the new 8/9-factor scoring scheme. Accepts either canonical
 * snake_case names ('bullish_breakout') or friendly labels
 * ('Bullish Breakout'). Unknown strategies fall back to
 * DEFAULT_STRATEGY_FACTOR_WEIGHTS with `source: 'default'`.
 *
 * Pure function. Safe to import from any layer.
 *
 * NOTE on naming: this file already exports `getStrategyWeights`
 * for the legacy 6-component `ScoringWeights` shape consumed by
 * `computeFinalScore`. The Phase-3 spec asked for a function with
 * the same name, but a name collision in the same file isn't
 * possible while the legacy callers still exist. This function is
 * therefore exposed as `getStrategyFactorWeights`. The integration
 * phase can rename / consolidate.
 */
export function getStrategyFactorWeights(name: string): StrategyWeightLookupResult {
  const key    = normalizeStrategyKey(name);
  const preset = STRATEGY_FACTOR_WEIGHT_PRESETS[key];
  if (preset) {
    return {
      strategy: key,
      weights:  preset,
      total:    sumStrategyFactorWeights(preset),
      source:   'preset',
    };
  }
  return {
    strategy: key,
    weights:  DEFAULT_STRATEGY_FACTOR_WEIGHTS,
    total:    sumStrategyFactorWeights(DEFAULT_STRATEGY_FACTOR_WEIGHTS),
    source:   'default',
  };
}

// ── Module-load validation ──────────────────────────────────────
//
// "Ensure weights approximately total 100 before penalties" —
// runs once at import time and throws on drift. Tolerance is 0.5
// to allow tiny rounding artefacts; anything wider is a bug.
(function validatePhase3Totals(): void {
  const TOLERANCE = 0.5;
  const all: Record<string, StrategyFactorWeights> = {
    ...STRATEGY_FACTOR_WEIGHT_PRESETS,
    __default: DEFAULT_STRATEGY_FACTOR_WEIGHTS,
  };
  for (const [name, w] of Object.entries(all)) {
    const total = sumStrategyFactorWeights(w);
    if (Math.abs(total - 100) > TOLERANCE) {
      throw new Error(
        `[strategyWeightModel] Phase-3 preset "${name}" sums to ${total}, expected ≈ 100`,
      );
    }
  }
})();

// ════════════════════════════════════════════════════════════════
//  Phase-3 → Phase-2 Bridge: getFinalScoreWeights
// ════════════════════════════════════════════════════════════════
//
//  Returns the 8-factor weights map that calculateFinalScore
//  consumes (FinalScoreFactorInputs keys, normalized to sum 1.0).
//
//  Why this bridge exists:
//    The Phase-3 presets above use point totals out of 100 across
//    8 (or 9, for mean_reversion) factor names. calculateFinalScore
//    expects six camelCase factor keys with weights summing to 1.0.
//    This function does both translations in one pass:
//
//      1. snake_case → camelCase (strategy_quality → strategyQuality)
//      2. divide by 100 to normalize to 1.0
//      3. fold support_strength (mean-reversion only) into
//         trend_alignment, since FinalScoreFactorInputs has no
//         dedicated support_strength field — "support holds" is
//         conceptually the same as "structural trend intact".
//      4. fill missing factors with 0 so calculateFinalScore's
//         normalize pass sees a complete 8-factor record.
//
//  Pure function. Safe to import from any layer.
// ════════════════════════════════════════════════════════════════

/** 8-factor weight map keyed by FinalScoreFactorInputs names.
 *  Mirrors `FINAL_SCORE_WEIGHTS` from scoringEngine but per-strategy. */
export type FinalScoreFactorWeights = {
  strategyQuality:    number;
  trendAlignment:     number;
  momentum:           number;
  volumeConfirmation: number;
  riskReward:         number;
  liquidity:          number;
  marketRegime:       number;
  portfolioFit:       number;
};

/**
 * Convert a Phase-3 preset (snake_case, points out of 100, possibly
 * with support_strength) into the 8-factor camelCase map normalized
 * to sum 1.0 — the shape calculateFinalScore expects via its optional
 * `weights` parameter.
 *
 * Unknown strategies fall through to DEFAULT_STRATEGY_FACTOR_WEIGHTS,
 * which produces (approximately) the same weights as
 * scoringEngine's `FINAL_SCORE_WEIGHTS`.
 */
export function getFinalScoreWeights(strategyName: string): FinalScoreFactorWeights {
  const lookup = getStrategyFactorWeights(strategyName);
  const w = lookup.weights;

  // Fold support_strength into trend_alignment for the 8-factor scheme.
  // calculateFinalScore has no support_strength field; "structural
  // support intact" is the closest semantic match to trend_alignment.
  const support = w.support_strength ?? 0;
  const trend   = (w.trend_alignment ?? 0) + support;

  // Sum may be slightly off 100 due to support_strength folding or
  // rounding artefacts — normalize so the final map sums to 1.0.
  const totalPoints =
    (w.strategy_quality    ?? 0) +
    trend                                     +
    (w.momentum            ?? 0) +
    (w.volume_confirmation ?? 0) +
    (w.risk_reward         ?? 0) +
    (w.liquidity           ?? 0) +
    (w.market_regime       ?? 0) +
    (w.portfolio_fit       ?? 0);
  const denom = totalPoints > 0 ? totalPoints : 100;

  return {
    strategyQuality:    (w.strategy_quality    ?? 0) / denom,
    trendAlignment:     trend                         / denom,
    momentum:           (w.momentum            ?? 0) / denom,
    volumeConfirmation: (w.volume_confirmation ?? 0) / denom,
    riskReward:         (w.risk_reward         ?? 0) / denom,
    liquidity:          (w.liquidity           ?? 0) / denom,
    marketRegime:       (w.market_regime       ?? 0) / denom,
    portfolioFit:       (w.portfolio_fit       ?? 0) / denom,
  };
}
