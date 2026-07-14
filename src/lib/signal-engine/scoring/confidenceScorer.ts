// ════════════════════════════════════════════════════════════════
//  Confidence Scorer — Phase 1 + Phase 2
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures, ConfidenceBreakdown, ConfidenceBand, StrategyName,
  RelativeStrengthFeatures, SetupConfidenceResult, FactorContribution,
} from '../types/signalEngine.types';
import { clamp, round } from '../utils/math';
import { isPriceNearFibLevel } from '../indicators/fibonacci';
import {
  CONFIDENCE_HIGH_CONVICTION,
  CONFIDENCE_ACTIONABLE,
  CONFIDENCE_WATCHLIST,
  MAX_ATR_PCT,
  MAX_GAP_PCT,
} from '../constants/signalEngine.constants';
import { applyPhase2ConfidenceCalibration } from './confidenceCalibration';
import { getSignalEngineConfig } from '../config/signalEnginePhase2Config';
import {
  CONFIDENCE_MODEL_VERSION,
  getCalibrationCellCache,
  resolveCalibrationHierarchy,
} from './empiricalCalibration';
import { assignSignalConfidenceTier } from './signalConfidenceTiers';

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
  const cfg = getSignalEngineConfig();
  const legacy = cfg.version < 2;
  const trendScore = scoreTrend(features);
  const momentumScore = scoreMomentum(features);
  const volumeScore = scoreVolume(features);
  const structureScore = scoreStructure(features);
  const contextScore = scoreContext(features, legacy);
  const penalty = computePenalties(features, legacy);

  const rawScore = trendScore + momentumScore + volumeScore + structureScore + contextScore;
  const finalScore = clamp(Math.round(rawScore - penalty.total), 0, 100);

  return {
    trendScore: round(trendScore),
    momentumScore: round(momentumScore),
    volumeScore: round(volumeScore),
    structureScore: round(structureScore),
    contextScore: round(contextScore),
    rawScore: round(rawScore),
    penaltyScore: round(penalty.total),
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
  if (f.momentum.adx >= 30) score += 1;
  return Math.min(score, 25);
}

// ── Momentum (max 20) ────────────────────────────────────────
function scoreMomentum(f: SignalFeatures): number {
  let score = 0;
  if (f.momentum.rsi14 >= RSI_IDEAL_LOW && f.momentum.rsi14 <= RSI_IDEAL_HIGH) score += 8;
  else if (f.momentum.rsi14 >= 50 && f.momentum.rsi14 <= RSI_OVERBOUGHT) score += 5;

  if (f.momentum.macdHistogram > 0) score += 6;
  if (f.momentum.roc5 > 0) score += 3;
  if (f.momentum.stochasticK >= 40 && f.momentum.stochasticK <= 80) score += 2;
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

  if (f.volume.breakoutVolumeRatio >= 1.0) score += 5;
  else if (f.volume.breakoutVolumeRatio >= 0.7) score += 3;

  if (f.volume.obvSlope > 5) score += 3;
  else if (f.volume.obvSlope > 0) score += 1;

  return Math.min(score, 20);
}

// ── Structure (max 20) ───────────────────────────────────────
function scoreStructure(f: SignalFeatures): number {
  let score = 0;
  if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 3) score += 10;
  else if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 5) score += 7;

  if (f.structure.breakoutDistancePct <= 2) score += 6;
  else if (f.structure.breakoutDistancePct <= 3.5) score += 4;

  if (f.structure.consecutiveHigherLows >= 3) score += 3;
  else if (f.structure.consecutiveHigherLows >= 2) score += 1;

  return Math.min(score, 20);
}

// ── Context (max 15) ─────────────────────────────────────────
/** Phase 2.2: regime alignment owned by composite; v1 keeps legacy regime bonuses. */
function scoreContext(f: SignalFeatures, legacyRegime: boolean): number {
  let score = 0;
  if (legacyRegime) {
    if (f.context.marketRegime === 'Strong Bullish') score += 10;
    else if (f.context.marketRegime === 'Bullish') score += 8;
    else if (f.context.marketRegime === 'Sideways') score += 4;
    else if (f.context.marketRegime === 'Weak') score += 1;
  } else {
    score += 6; // neutral setup-context base (no regime double-count)
  }

  if (f.context.liquidityPass) score += 3;
  if (f.volatility.squeezed) score += 2;

  return Math.min(score, 15);
}

/** Phase 2.2: risk/regime overlapping penalties only in legacy (v1) mode. */
function computePenalties(
  f: SignalFeatures,
  legacyOverlapping: boolean,
): { total: number; items: FactorContribution[] } {
  const items: FactorContribution[] = [];
  let penalty = 0;
  const add = (name: string, points: number) => {
    if (points <= 0) return;
    penalty += points;
    items.push({ name, points: -points, layer: 'setup' });
  };

  if (legacyOverlapping) {
    if (f.trend.distanceFrom20EmaPct > 5) add('overextension_ema20', 8);
    else if (f.trend.distanceFrom20EmaPct > 3) add('overextension_ema20', 4);
    if (f.volatility.atrPct > MAX_ATR_PCT * 0.75) add('atr_risk', 6);
    else if (f.volatility.atrPct > MAX_ATR_PCT * 0.5) add('atr_risk', 3);
    if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.5) add('gap_risk', 5);
    else if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.25) add('gap_risk', 2);
    if (f.context.marketRegime === 'Sideways') add('regime_sideways', 5);
    if (f.context.marketRegime === 'Weak') add('regime_weak', 8);
  }

  if (f.momentum.rsi14 > RSI_OVERBOUGHT) add('rsi_exhaustion', 6);
  else if (f.momentum.rsi14 > RSI_IDEAL_HIGH) add('rsi_exhaustion', 3);
  if (f.momentum.bearishDivergence) add('bearish_divergence', 5);

  return { total: penalty, items };
}

function classifyConfidence(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_HIGH_CONVICTION) return 'High Conviction';
  if (score >= CONFIDENCE_ACTIONABLE) return 'Actionable';
  if (score >= CONFIDENCE_WATCHLIST) return 'Watchlist';
  return 'Avoid';
}

/**
 * Setup confidence scorer — sole production entry for setup confidence.
 * Returns SetupConfidenceResult (extends ConfidenceBreakdown).
 *
 * @see docs/product-a/scoring-terminology.md — "Setup Confidence"
 * @see docs/product-a/confidence-calibration.md
 */
export function scoreConfidenceForStrategy(
  features: SignalFeatures,
  strategy: StrategyName,
  rs: RelativeStrengthFeatures,
): SetupConfidenceResult {
  const cfg = getSignalEngineConfig();
  const legacy = cfg.version < 2;
  const base = scoreConfidence(features);
  const penaltyDetail = computePenalties(features, legacy);
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

      if (nearKeyFib && trendBullish && emaSupport && rsiInPullbackBand && volumeAcceptable && regimeSupportive) {
        if (near382 || near50 || near618) adjustment += 2;
        adjustment += 2;
        if (trend.closeAbove20Ema && trend.closeAbove50Ema) adjustment += 1;
        adjustment += 2;
        if (volumeHealthy) adjustment += 2;
        else adjustment += 1;
        // Regime boosts only in legacy mode — composite owns regime alignment in v2
        if (legacy) {
          if (context.marketRegime === 'Strong Bullish') adjustment += 2;
          else adjustment += 1;
        }
      }

      if (isBelowFibLevel(close, fib618, FIB_CONFIDENCE_TOLERANCE_PCT)) adjustment -= 5;
      else if (isBelowFibLevel(close, fib786, FIB_CONFIDENCE_TOLERANCE_PCT)) adjustment -= 4;
      if (momentum.rsi14 > FIB_PULLBACK_RSI_HIGH) adjustment -= 4;
      if (!volumeAcceptable) adjustment -= 3;
      if (legacy) {
        if (context.marketRegime === 'Bearish') adjustment -= 5;
        if (context.marketRegime === 'High Volatility Risk') adjustment -= 4;
      }
      break;
    }
  }

  if (rs.sectorStrengthScore >= 65 && strategy !== 'bearish_breakdown') adjustment += 2;
  if (rs.sectorStrengthScore <= 35 && strategy !== 'bearish_breakdown') adjustment -= 3;

  const adjusted = clamp(base.finalScore + adjustment, 0, 100);
  let result: ConfidenceBreakdown = {
    ...base,
    finalScore: adjusted,
    band: classifyConfidence(adjusted),
  };
  result = applyPhase2ConfidenceCalibration(result, features, strategy);

  // Empirical calibration (2.3–2.5) — no material change when cache empty / insufficient
  const hierarchy = resolveCalibrationHierarchy(
    result.finalScore,
    strategy,
    features.context.marketRegime,
    null,
    getCalibrationCellCache(),
  );
  let finalScore = result.finalScore;
  if (hierarchy.appliedModifier !== 0 && hierarchy.level !== 'none') {
    finalScore = clamp(result.finalScore + hierarchy.appliedModifier, 0, 100);
  }

  const factorContributions: FactorContribution[] = [
    { name: 'trend', points: base.trendScore, layer: 'setup' },
    { name: 'momentum', points: base.momentumScore, layer: 'setup' },
    { name: 'volume', points: base.volumeScore, layer: 'setup' },
    { name: 'structure', points: base.structureScore, layer: 'setup' },
    { name: 'context', points: base.contextScore, layer: 'setup' },
    { name: 'strategy_adjustment', points: adjustment, layer: 'setup' },
  ];
  if (hierarchy.appliedModifier !== 0) {
    factorContributions.push({
      name: `empirical_calibration:${hierarchy.level}`,
      points: hierarchy.appliedModifier,
      layer: 'setup',
    });
  }

  const band = classifyConfidence(finalScore);
  const tier = assignSignalConfidenceTier({
    calibratedProbability: hierarchy.calibratedProbability,
    calibrationSampleSize: hierarchy.cell?.sampleSize ?? 0,
    rawBand: band,
  });

  const out: SetupConfidenceResult = {
    ...result,
    finalScore,
    band,
    confidenceBand: band,
    calibratedProbability: hierarchy.calibratedProbability,
    factorContributions,
    penalties: penaltyDetail.items,
    calibrationSampleSize: hierarchy.cell?.sampleSize ?? 0,
    calibrationWindow: hierarchy.level === 'none' ? null : hierarchy.level,
    calibrationState: hierarchy.cell?.calibrationState ?? 'insufficient_data',
    modelVersion: CONFIDENCE_MODEL_VERSION,
    signalTier: tier.tier,
    evidenceLabel: tier.evidenceLabel,
  };

  return out;
}
