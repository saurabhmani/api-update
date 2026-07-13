// ════════════════════════════════════════════════════════════════
//  Phase 2 — Enhanced Feature Engineering
//
//  Derives normalized 0..100 quality scores from canonical Phase 1
//  features. Pure, deterministic, no IO.
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures,
  RelativeStrengthFeatures,
  EnhancedFeatures,
} from '../types/signalEngine.types';
import { normalizeFeatureScore, invertFeatureScore } from './normalizeFeatureScore';
import { safeDivide } from '../utils/math';

const DEFAULT_RS: RelativeStrengthFeatures = {
  rsVsIndex: 0,
  rsVsSector: 0,
  sectorStrengthScore: 50,
};

/**
 * Build Phase 2 enhanced features from canonical SignalFeatures.
 * All outputs are normalized 0..100 unless noted.
 */
export function buildEnhancedFeatures(
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures = DEFAULT_RS,
): EnhancedFeatures {
  const { trend, momentum, volume, volatility, structure, context } = features;

  // ── Trend strength (ADX + EMA stack) ───────────────────────
  let trendStrength = 0;
  if (trend.closeAbove20Ema) trendStrength += 20;
  if (trend.closeAbove50Ema) trendStrength += 20;
  if (trend.ema20Above50) trendStrength += 15;
  if (trend.closeAbove200Ema) trendStrength += 10;
  if (trend.ema50Above200) trendStrength += 10;
  trendStrength += normalizeFeatureScore(momentum.adx, 15, 40) * 0.25;
  trendStrength = Math.min(100, Math.round(trendStrength));

  // ── Volume quality ─────────────────────────────────────────
  const volumeQuality = Math.min(100, Math.round(
    normalizeFeatureScore(volume.volumeVs20dAvg, 0.8, 2.5) * 0.5
    + normalizeFeatureScore(volume.obvSlope, -5, 15) * 0.3
    + normalizeFeatureScore(volume.breakoutVolumeRatio, 0.5, 1.2) * 0.2,
  ));

  // ── Volatility regime (lower ATR% = calmer = higher score for swing) ─
  const volatilityRegime = invertFeatureScore(
    normalizeFeatureScore(volatility.atrPct, 1.5, 8),
  );

  // ── Breakout quality ───────────────────────────────────────
  let breakoutQuality = 0;
  if (structure.breakoutDistancePct > 0) {
    const distScore = structure.breakoutDistancePct <= 2
      ? 90
      : structure.breakoutDistancePct <= 3.5
        ? 70
        : structure.breakoutDistancePct <= 5
          ? 45
          : 20;
    breakoutQuality = Math.round(
      distScore * 0.5
      + normalizeFeatureScore(volume.volumeVs20dAvg, 1.2, 2.5) * 0.3
      + (structure.consecutiveHigherLows >= 2 ? 20 : 0),
    );
  }

  // ── Liquidity quality ──────────────────────────────────────
  const liquidityQuality = Math.min(100, Math.round(
    (context.liquidityPass ? 40 : 0)
    + normalizeFeatureScore(volume.avgVolume20, 50_000, 500_000) * 0.35
    + normalizeFeatureScore(trend.close, 50, 500) * 0.25,
  ));

  // ── Relative strength ──────────────────────────────────────
  const relativeStrengthScore = Math.min(100, Math.round(
    normalizeFeatureScore(relativeStrength.rsVsIndex, -5, 8) * 0.45
    + normalizeFeatureScore(relativeStrength.sectorStrengthScore, 30, 75) * 0.35
    + normalizeFeatureScore(relativeStrength.rsVsSector, -3, 5) * 0.2,
  ));

  // ── Momentum persistence ───────────────────────────────────
  const momentumPersistence = Math.min(100, Math.round(
    (momentum.roc5 > 0 && momentum.roc20 > 0 ? 25 : 0)
    + (momentum.macdHistogram > 0 ? 20 : 0)
    + normalizeFeatureScore(momentum.adx, 20, 35) * 0.25
    + (structure.consecutiveHigherLows >= 2 ? 15 : 0)
    + (momentum.bullishDivergence ? 10 : 0)
    - (momentum.bearishDivergence ? 15 : 0),
  ));

  // ── Risk-adjusted reward (structure-based estimate) ────────
  const stopDistEst = Math.max(
    Math.abs(trend.close - structure.recentSupport20),
    volatility.atr14 * 1.5,
  );
  const rewardEst = Math.max(0, structure.recentResistance20 - trend.close);
  const rrEst = safeDivide(rewardEst, stopDistEst, 0);
  const riskAdjustedReward = normalizeFeatureScore(rrEst, 0.8, 3.0);

  // ── ATR efficiency (reward per unit of volatility) ───────────
  const atrEfficiency = normalizeFeatureScore(
    safeDivide(Math.abs(momentum.roc20), Math.max(volatility.atrPct, 0.1), 0),
    0.5,
    4,
  );

  // ── EMA compression (Bollinger squeeze + narrow EMA spread) ──
  const emaSpreadPct = safeDivide(
    Math.abs(trend.ema20 - trend.ema50),
    trend.close,
    0,
  ) * 100;
  const emaCompression = Math.min(100, Math.round(
    (volatility.squeezed ? 40 : 0)
    + invertFeatureScore(normalizeFeatureScore(emaSpreadPct, 0.5, 4)) * 0.4
    + invertFeatureScore(normalizeFeatureScore(volatility.bollingerWidth, 2, 12)) * 0.2,
  ));

  // ── Swing structure ──────────────────────────────────────────
  const swingStructure = Math.min(100, Math.round(
    normalizeFeatureScore(structure.consecutiveHigherLows, 0, 5) * 0.4
    + (structure.rangeCompressionRatio < 0.7 ? 25 : structure.rangeCompressionRatio < 0.9 ? 15 : 0)
    + (structure.isInsideDay ? 10 : 0)
    + (structure.fibZoneMatched ? 15 : 0),
  ));

  // ── Support / resistance proximity ───────────────────────────
  const distToSupport = Math.abs(structure.distanceToSupportPct);
  const distToResist = Math.abs(structure.distanceToResistancePct);
  const supportResistanceProximity = Math.min(100, Math.round(
    invertFeatureScore(normalizeFeatureScore(distToSupport, 0, 5)) * 0.5
    + normalizeFeatureScore(structure.breakoutDistancePct, 0, 3) * 0.5,
  ));

  // ── Trend exhaustion (higher = more exhausted) ───────────────
  const trendExhaustion = Math.min(100, Math.round(
    normalizeFeatureScore(trend.distanceFrom20EmaPct, 3, 10) * 0.35
    + normalizeFeatureScore(momentum.rsi14, 68, 85) * 0.35
    + normalizeFeatureScore(structure.breakoutDistancePct, 3, 8) * 0.3,
  ));

  // ── Market participation ─────────────────────────────────────
  const marketParticipation = Math.min(100, Math.round(
    normalizeFeatureScore(volume.volumeVs20dAvg, 0.9, 2.0) * 0.4
    + normalizeFeatureScore(volume.volumeClimaxRatio, 1, 3) * 0.2
    + (volume.obvSlope > 0 ? 20 : 0)
    + normalizeFeatureScore(volume.breakoutVolumeRatio, 0.6, 1.0) * 0.2,
  ));

  // ── Multi-timeframe alignment (daily-only proxy when no 4H/1H) ─
  let mtfScore = 0;
  if (trend.closeAbove20Ema && trend.ema20Above50) mtfScore += 40;
  else if (trend.closeAbove20Ema) mtfScore += 20;
  if (momentum.adx >= 25) mtfScore += 25;
  if (momentum.macdHistogram > 0) mtfScore += 20;
  if (context.marketRegime === 'Strong Bullish' || context.marketRegime === 'Bullish') mtfScore += 15;
  const multiTimeframeAlignment = Math.min(100, mtfScore);

  return {
    trendStrength,
    volumeQuality,
    volatilityRegime,
    breakoutQuality,
    liquidityQuality,
    relativeStrength: relativeStrengthScore,
    momentumPersistence,
    riskAdjustedReward,
    atrEfficiency,
    emaCompression,
    swingStructure,
    supportResistanceProximity,
    trendExhaustion,
    marketParticipation,
    multiTimeframeAlignment,
  };
}
