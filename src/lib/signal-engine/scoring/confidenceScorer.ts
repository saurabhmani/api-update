// ════════════════════════════════════════════════════════════════
//  Confidence Scorer — Phase 1 + Phase 2
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, ConfidenceBreakdown, ConfidenceBand, StrategyName, RelativeStrengthFeatures } from '../types/signalEngine.types';
import { clamp, round } from '../utils/math';
import { isPriceNearFibLevel } from '../indicators/fibonacci';
import {
  CONFIDENCE_HIGH_CONVICTION,
  CONFIDENCE_ACTIONABLE,
  CONFIDENCE_WATCHLIST,
  MAX_ATR_PCT,
  MAX_GAP_PCT,
} from '../constants/signalEngine.constants';

// RSI thresholds for confidence (standalone, not tied to breakout range)
const RSI_OVERBOUGHT = 76;
const RSI_IDEAL_LOW = 55;
const RSI_IDEAL_HIGH = 72;

/** Matches fibonacci_pullback strategy golden-zone tolerance. */
const FIB_CONFIDENCE_TOLERANCE_PCT = 1;
const FIB_PULLBACK_RSI_LOW = 42;
const FIB_PULLBACK_RSI_HIGH = 65;
const FIB_MIN_VOLUME_RATIO = 0.8;
const FIB_HEALTHY_VOLUME_RATIO = 1.0;

function isBelowFibLevel(close: number, level: number | undefined, tolerancePct: number): boolean {
  if (level === undefined || !Number.isFinite(level)) return false;
  if (level === 0) return close < 0;
  return close < level * (1 - tolerancePct / 100);
}

export function scoreConfidence(features: SignalFeatures): ConfidenceBreakdown {
  const trendScore = scoreTrend(features);
  const momentumScore = scoreMomentum(features);
  const volumeScore = scoreVolume(features);
  const structureScore = scoreStructure(features);
  const contextScore = scoreContext(features);

  const rawScore = trendScore + momentumScore + volumeScore + structureScore + contextScore;
  const penaltyScore = computePenalties(features);
  const finalScore = clamp(Math.round(rawScore - penaltyScore), 0, 100);

  return {
    trendScore: round(trendScore),
    momentumScore: round(momentumScore),
    volumeScore: round(volumeScore),
    structureScore: round(structureScore),
    contextScore: round(contextScore),
    rawScore: round(rawScore),
    penaltyScore: round(penaltyScore),
    finalScore,
    band: classifyConfidence(finalScore),
  };
}

// ── Trend (max 25) ───────────────────────────────────────────
function scoreTrend(f: SignalFeatures): number {
  let score = 0;
  if (f.trend.closeAbove20Ema) score += 7;
  if (f.trend.closeAbove50Ema) score += 7;
  if (f.trend.ema20Above50) score += 5;
  if (f.trend.closeAbove200Ema) score += 3;
  if (f.trend.ema50Above200) score += 2;
  // ADX-informed trend strength bonus
  if (f.momentum.adx >= 30) score += 1;
  return Math.min(score, 25);
}

// ── Momentum (max 20) ────────────────────────────────────────
function scoreMomentum(f: SignalFeatures): number {
  let score = 0;
  // RSI in ideal range
  if (f.momentum.rsi14 >= RSI_IDEAL_LOW && f.momentum.rsi14 <= RSI_IDEAL_HIGH) score += 8;
  else if (f.momentum.rsi14 >= 50 && f.momentum.rsi14 <= RSI_OVERBOUGHT) score += 5;

  if (f.momentum.macdHistogram > 0) score += 6;
  if (f.momentum.roc5 > 0) score += 3;

  // Stochastic confirmation
  if (f.momentum.stochasticK >= 40 && f.momentum.stochasticK <= 80) score += 2;

  // ADX confirms trend exists
  if (f.momentum.adx >= 25) score += 1;

  return Math.min(score, 20);
}

// ── Volume (max 20) ──────────────────────────────────────────
function scoreVolume(f: SignalFeatures): number {
  let score = 0;
  const ratio = f.volume.volumeVs20dAvg;
  if (ratio >= 2.5) score += 12;
  else if (ratio >= 2.0) score += 10;
  else if (ratio >= 1.5) score += 8;
  else if (ratio >= 1.2) score += 5;

  // Breakout volume relative to recent max
  if (f.volume.breakoutVolumeRatio >= 1.0) score += 5;
  else if (f.volume.breakoutVolumeRatio >= 0.7) score += 3;

  // OBV slope positive = accumulation confirming
  if (f.volume.obvSlope > 5) score += 3;
  else if (f.volume.obvSlope > 0) score += 1;

  return Math.min(score, 20);
}

// ── Structure (max 20) ───────────────────────────────────────
function scoreStructure(f: SignalFeatures): number {
  let score = 0;
  // Clean break above resistance
  if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 3) score += 10;
  else if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 5) score += 7;

  // Not too stretched above resistance
  if (f.structure.breakoutDistancePct <= 2) score += 6;
  else if (f.structure.breakoutDistancePct <= 3.5) score += 4;

  // Consecutive higher lows = bullish structure
  if (f.structure.consecutiveHigherLows >= 3) score += 3;
  else if (f.structure.consecutiveHigherLows >= 2) score += 1;

  return Math.min(score, 20);
}

// ── Context (max 15) ─────────────────────────────────────────
function scoreContext(f: SignalFeatures): number {
  let score = 0;
  if (f.context.marketRegime === 'Strong Bullish') score += 10;
  else if (f.context.marketRegime === 'Bullish') score += 8;
  else if (f.context.marketRegime === 'Sideways') score += 4;
  else if (f.context.marketRegime === 'Weak') score += 1;

  if (f.context.liquidityPass) score += 3;

  // Bollinger squeeze = volatility compression (potential for big move)
  if (f.volatility.squeezed) score += 2;

  return Math.min(score, 15);
}

// ── Penalties ────────────────────────────────────────────────
function computePenalties(f: SignalFeatures): number {
  let penalty = 0;

  // Overextension from EMA20
  if (f.trend.distanceFrom20EmaPct > 5) penalty += 8;
  else if (f.trend.distanceFrom20EmaPct > 3) penalty += 4;

  // Excessive ATR
  if (f.volatility.atrPct > MAX_ATR_PCT * 0.75) penalty += 6;
  else if (f.volatility.atrPct > MAX_ATR_PCT * 0.5) penalty += 3;

  // Excessive gap
  if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.5) penalty += 5;
  else if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.25) penalty += 2;

  // RSI approaching exhaustion (using dedicated threshold, not breakout range)
  if (f.momentum.rsi14 > RSI_OVERBOUGHT) penalty += 6;
  else if (f.momentum.rsi14 > RSI_IDEAL_HIGH) penalty += 3;

  // Weaker regime context
  if (f.context.marketRegime === 'Sideways') penalty += 5;
  if (f.context.marketRegime === 'Weak') penalty += 8;

  // Bearish divergence = momentum warning
  if (f.momentum.bearishDivergence) penalty += 5;

  return penalty;
}

// ── Confidence Band ──────────────────────────────────────────
function classifyConfidence(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_HIGH_CONVICTION) return 'High Conviction';
  if (score >= CONFIDENCE_ACTIONABLE) return 'Actionable';
  if (score >= CONFIDENCE_WATCHLIST) return 'Watchlist';
  return 'Avoid';
}

// ════════════════════════════════════════════════════════════════
//  Strategy-Specific Confidence — Phase 2
// ════════════════════════════════════════════════════════════════

/**
 * Setup confidence scorer (Phase 1–2). Produces the 0–100
 * `confidence_score` stored on `q365_signals` before trade-plan and
 * Phase-4 structural scoring run. Applies generic `scoreConfidence()`
 * plus per-strategy adjustment deltas only — no final-score bands.
 *
 * @see docs/product-a/scoring-terminology.md — "Setup Confidence"
 */
export function scoreConfidenceForStrategy(
  features: SignalFeatures,
  strategy: StrategyName,
  rs: RelativeStrengthFeatures,
): ConfidenceBreakdown {
  const base = scoreConfidence(features);
  let adjustment = 0;

  switch (strategy) {
    case 'bullish_breakout':
      if (features.volume.volumeVs20dAvg >= 2.0) adjustment += 3;
      if (features.structure.breakoutDistancePct > 0 && features.structure.breakoutDistancePct <= 1.5) adjustment += 4;
      if (rs.rsVsIndex > 2) adjustment += 3;
      break;

    case 'bullish_pullback':
      if (features.trend.ema20Above50 && features.trend.ema50Above200) adjustment += 5;
      if (features.momentum.rsi14 >= 42 && features.momentum.rsi14 <= 55) adjustment += 4;
      if (features.volume.volumeVs20dAvg < 1.0) adjustment += 3;
      if (rs.rsVsIndex > 0) adjustment += 2;
      break;

    case 'bearish_breakdown':
      if (features.volume.volumeVs20dAvg >= 1.5) adjustment += 4;
      if (!features.trend.closeAbove20Ema && !features.trend.closeAbove50Ema) adjustment += 4;
      if (rs.rsVsIndex < -2) adjustment += 3;
      if (rs.sectorStrengthScore < 40) adjustment += 2;
      break;

    case 'mean_reversion_bounce':
      if (features.momentum.rsi14 <= 30) adjustment += 5;
      if (features.volume.volumeVs20dAvg >= 1.3) adjustment += 3;
      if (features.trend.closeAbove200Ema) adjustment += 3;
      break;

    case 'momentum_continuation':
      if (features.momentum.adx >= 35) adjustment += 4;
      if (features.volume.obvSlope > 10) adjustment += 3;
      if (features.momentum.roc5 > 2 && features.momentum.roc20 > 5) adjustment += 3;
      if (rs.rsVsIndex > 3) adjustment += 3;
      break;

    case 'bullish_divergence':
      if (features.momentum.rsi14 <= 30) adjustment += 5;
      if (features.momentum.stochasticK < 25) adjustment += 3;
      if (features.volume.volumeVs20dAvg >= 1.2) adjustment += 3;
      if (features.trend.closeAbove200Ema) adjustment += 2;
      break;

    case 'volume_climax_reversal':
      if (features.volume.volumeClimaxRatio >= 4.0) adjustment += 5;
      if (features.momentum.rsi14 <= 25) adjustment += 4;
      if (features.momentum.stochasticK < 15) adjustment += 3;
      break;

    case 'gap_continuation':
      if (features.volatility.gapPct >= 2.0 && features.volatility.gapPct <= 4.0) adjustment += 4;
      if (features.volume.volumeVs20dAvg >= 2.0) adjustment += 3;
      if (features.structure.breakoutDistancePct > 0 && features.structure.breakoutDistancePct <= 2) adjustment += 3;
      if (rs.rsVsIndex > 2) adjustment += 2;
      break;

    case 'fibonacci_pullback': {
      const { trend, momentum, volume, structure, context } = features;
      const close = trend.close;
      const { fib382, fib50, fib618, fib786 } = structure;
      const near382 = fib382 !== undefined && isPriceNearFibLevel(close, fib382, FIB_CONFIDENCE_TOLERANCE_PCT);
      const near50 = fib50 !== undefined && isPriceNearFibLevel(close, fib50, FIB_CONFIDENCE_TOLERANCE_PCT);
      const near618 = fib618 !== undefined && isPriceNearFibLevel(close, fib618, FIB_CONFIDENCE_TOLERANCE_PCT);
      const nearKeyFib = near382 || near50 || near618;
      const trendBullish = trend.ema20Above50 && trend.closeAbove200Ema;
      const emaSupport = trend.closeAbove20Ema || trend.closeAbove50Ema;
      const rsiInPullbackBand =
        momentum.rsi14 >= FIB_PULLBACK_RSI_LOW && momentum.rsi14 <= FIB_PULLBACK_RSI_HIGH;
      const volumeAcceptable = volume.volumeVs20dAvg >= FIB_MIN_VOLUME_RATIO;
      const volumeHealthy = volume.volumeVs20dAvg >= FIB_HEALTHY_VOLUME_RATIO;
      const regimeSupportive =
        context.marketRegime === 'Bullish' || context.marketRegime === 'Strong Bullish';

      // Bonus only when Fibonacci aligns with trend, RSI, and volume — not Fib alone.
      if (nearKeyFib && trendBullish && emaSupport && rsiInPullbackBand && volumeAcceptable && regimeSupportive) {
        if (near382 || near50 || near618) adjustment += 2;
        adjustment += 2; // bullish trend structure
        if (trend.closeAbove20Ema && trend.closeAbove50Ema) adjustment += 1;
        adjustment += 2; // RSI in constructive pullback band
        if (volumeHealthy) adjustment += 2;
        else adjustment += 1;
        if (context.marketRegime === 'Strong Bullish') adjustment += 2;
        else adjustment += 1;
      }

      // Penalties — Fibonacci-specific risk factors
      if (isBelowFibLevel(close, fib618, FIB_CONFIDENCE_TOLERANCE_PCT)) adjustment -= 5;
      else if (isBelowFibLevel(close, fib786, FIB_CONFIDENCE_TOLERANCE_PCT)) adjustment -= 4;
      if (momentum.rsi14 > FIB_PULLBACK_RSI_HIGH) adjustment -= 4;
      if (!volumeAcceptable) adjustment -= 3;
      if (context.marketRegime === 'Bearish') adjustment -= 5;
      if (context.marketRegime === 'High Volatility Risk') adjustment -= 4;
      break;
    }
  }

  // RS context bonus/penalty
  if (rs.sectorStrengthScore >= 65 && strategy !== 'bearish_breakdown') adjustment += 2;
  if (rs.sectorStrengthScore <= 35 && strategy !== 'bearish_breakdown') adjustment -= 3;

  const adjusted = clamp(base.finalScore + adjustment, 0, 100);

  return {
    ...base,
    finalScore: adjusted,
    band: classifyConfidence(adjusted),
  };
}
