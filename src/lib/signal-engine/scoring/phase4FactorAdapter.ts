// ════════════════════════════════════════════════════════════════
//  Phase-4 Factor-Score Adapter
//
//  Single source of truth that converts the upstream Phase-3
//  candidate context (confidence breakdown, risk breakdown, trade
//  plan, portfolio fit, regime alignment, features) into the eight
//  factor scores + three penalties consumed by Phase-2's
//  `calculateFinalScore`. Used by BOTH the batch path
//  (`generatePhase3Signals.ts`) and the live path
//  (`analyzeInstrument.ts`) so the two outputs are guaranteed to
//  carry identical fields.
//
//  Why an adapter (and not inline conversion in each pipeline):
//    The user spec demands "live and batch outputs contain identical
//    fields". The cheapest way to guarantee that is to derive every
//    factor score from the same function. If a future change tunes
//    the volume → factor mapping, both paths inherit the change with
//    no risk of drift.
//
//  Pure function. Stateless. IO-free.
// ════════════════════════════════════════════════════════════════

import {
  calculateFinalScore,
  type FinalScoreInput,
  type FinalScoreBand,
  type FinalScoreResult,
  type FinalScoreFactorInputs,
} from './scoringEngine';
import { getFinalScoreWeights } from './strategyWeightModel';

/** Tri-state inherited from upstream rejection engine. When set,
 *  the resulting classification is forced to match — calculateFinalScore
 *  alone classifies by score, but a NO_TRADE / DEVELOPING_SETUP
 *  decision must never be silently upgraded into VALID_SIGNAL etc. */
export type Phase4UpstreamStatus =
  | 'APPROVED_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'NO_TRADE';

/** Normalized input shape both pipelines can populate from their
 *  own data. Every field is optional / nullable — the adapter
 *  substitutes a neutral default for any missing dimension so a
 *  single missing field cannot tank the score. */
export interface Phase4ScoringContext {
  // Quality 0-100 dimensions ────────────────────────────────────
  /** Overall confidence (the "is this pattern good?" composite). */
  strategyQuality:    number | null;
  /** Trend health 0-100. */
  trendAlignment:     number | null;
  /** Momentum strength 0-100. */
  momentum:           number | null;
  /** Volume confirmation 0-100. */
  volumeConfirmation: number | null;
  /** Liquidity quality 0-100. */
  liquidity:          number | null;
  /** Regime alignment 0-100 (how favourable is the tape). */
  marketRegime:       number | null;
  /** Portfolio fit 0-100 (sector/correlation/capacity). */
  portfolioFit:       number | null;

  // Ratios / raw measurements ───────────────────────────────────
  /** R:R ratio. ≥3.0 saturates the score. */
  riskRewardRatio:    number;
  /** Volume vs 20-day average ratio (1.0 = average). Used to
   *  derive liquidity if `liquidity` itself is null. */
  volumeVs20dAvg?:    number | null;
  /** ATR%, used for the volatility-shock penalty. */
  atrPct?:            number | null;

  // Penalty inputs ──────────────────────────────────────────────
  /** Manipulation engine 0-100 score. Higher = riskier. */
  manipulationScore?: number | null;
  /** Signal age in bars. At generation time this is 0. */
  ageBars?:           number | null;

  // Upstream override ───────────────────────────────────────────
  upstreamStatus?:    Phase4UpstreamStatus;

  // Phase-3 per-strategy weight selection ───────────────────────
  /** Strategy name (e.g. 'bullish_breakout'). When supplied, the
   *  scorer uses Phase-3's per-strategy factor weights instead of
   *  the global FINAL_SCORE_WEIGHTS. Unknown names fall back to
   *  the default 8-factor weighting. Omit for the legacy global
   *  weighting. */
  strategyName?:      string;
}

/** Result returned by the adapter — the full Phase-2 result PLUS
 *  the resolved classification (post upstream-override) and a
 *  flat snake_case factor_scores object for direct DB persistence. */
export interface Phase4ScoringResult {
  final_score:    number;
  classification: FinalScoreBand;
  factor_scores:  FinalScoreResult['factor_scores'];
  breakdown:      FinalScoreResult['breakdown'];
  /** The full Phase-2 result, in case callers want the contributions. */
  raw:            FinalScoreResult;
}

// ── Conversions ─────────────────────────────────────────────────

/** Piecewise-linear R:R → 0-100 score.
 *    0.0 → 0, 1.0 → 33, 1.5 → 50, 2.0 → 67, 3.0+ → 100. */
export function rewardRiskRatioToScore(rr: number | null | undefined): number {
  if (rr == null || !Number.isFinite(rr) || rr <= 0) return 0;
  if (rr >= 3) return 100;
  return (rr / 3) * 100;
}

/** Volume-vs-average → liquidity 0-100.
 *    0.5x → 25, 1.0x → 50, 1.5x → 75, 2.0+x → 100. */
function volRatioToLiquidity(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return 50;
  return Math.max(0, Math.min(100, ratio * 50));
}

/** Manipulation score 0-100 → penalty 0-30 points. */
function manipulationToPenalty(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score) || score <= 0) return 0;
  const clamped = Math.max(0, Math.min(100, score));
  return Math.round((clamped / 100) * 30 * 10) / 10;
}

/** Signal age in bars → staleness penalty 0-30 points.
 *    0 bars → 0, 4 → 10, 8 → 20, 12+ → 30 (≈ 2.5 points per bar). */
function ageToStalenessPenalty(ageBars: number | null | undefined): number {
  if (ageBars == null || !Number.isFinite(ageBars) || ageBars <= 0) return 0;
  return Math.round(Math.min(30, ageBars * 2.5) * 10) / 10;
}

/** ATR% → volatility-shock penalty 0-30 points.
 *    ≤4%  → 0, 5% → 7.5, 6% → 15, 7% → 22.5, 8%+ → 30. */
function atrPctToVolPenalty(atrPct: number | null | undefined): number {
  if (atrPct == null || !Number.isFinite(atrPct) || atrPct <= 4) return 0;
  return Math.round(Math.min(30, (atrPct - 4) * 7.5) * 10) / 10;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Convert a Phase4ScoringContext into the FinalScoreInput Phase-2
 * `calculateFinalScore` consumes. Exposed independently so callers
 * that want only the input (e.g. for logging) can derive it.
 */
export function buildFinalScoreInput(ctx: Phase4ScoringContext): FinalScoreInput {
  const liquidity = ctx.liquidity != null
    ? ctx.liquidity
    : volRatioToLiquidity(ctx.volumeVs20dAvg);

  return {
    strategyQuality:    ctx.strategyQuality,
    trendAlignment:     ctx.trendAlignment,
    momentum:           ctx.momentum,
    volumeConfirmation: ctx.volumeConfirmation,
    riskReward:         rewardRiskRatioToScore(ctx.riskRewardRatio),
    liquidity,
    marketRegime:       ctx.marketRegime,
    portfolioFit:       ctx.portfolioFit,
    manipulationRiskPenalty: manipulationToPenalty(ctx.manipulationScore),
    stalenessPenalty:        ageToStalenessPenalty(ctx.ageBars),
    volatilityShockPenalty:  atrPctToVolPenalty(ctx.atrPct),
  };
}

/**
 * Apply upstream override to a calculateFinalScore result. NO_TRADE
 * and DEVELOPING_SETUP from the rejection engine MUST flow through
 * to the final classification — calculateFinalScore is purely
 * score-based and would otherwise upgrade a rejected row.
 */
function applyUpstreamOverride(
  cls:    FinalScoreBand,
  status: Phase4UpstreamStatus | undefined,
): FinalScoreBand {
  if (status === 'NO_TRADE')         return 'NO_TRADE';
  if (status === 'DEVELOPING_SETUP') return 'DEVELOPING_SETUP';
  return cls;
}

/**
 * Phase-4 scoring entry point.
 *
 * Builds the Phase-2 input from the supplied context, runs
 * calculateFinalScore, applies the upstream-status override, and
 * returns a flat result ready for both signal-object attachment
 * and DB persistence.
 *
 * Pure function. Safe to call from any layer.
 */
export function runPhase4Scoring(ctx: Phase4ScoringContext): Phase4ScoringResult {
  const input  = buildFinalScoreInput(ctx);
  // Phase-3 per-strategy weights when a strategy is named, otherwise
  // the global FINAL_SCORE_WEIGHTS via calculateFinalScore's default.
  const weights = ctx.strategyName ? getFinalScoreWeights(ctx.strategyName) : undefined;
  const raw    = calculateFinalScore(input, weights);
  const finalCls = applyUpstreamOverride(raw.classification, ctx.upstreamStatus);

  return {
    final_score:    raw.finalScore,
    classification: finalCls,
    factor_scores:  raw.factor_scores,
    breakdown:      raw.breakdown,
    raw,
  };
}

// Re-export the Phase-2 types so callers can import everything they
// need from this single adapter file.
export type { FinalScoreBand, FinalScoreFactorInputs };
