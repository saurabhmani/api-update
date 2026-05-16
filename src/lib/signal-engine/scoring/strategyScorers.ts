// ════════════════════════════════════════════════════════════════
//  Strategy-Specific Scorers — Phase 2
//
//  Each strategy defines its own scoring formula with unique
//  category weights, ideal ranges, and penalty rules.
//  These replace the generic scoreConfidenceForStrategy().
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures, ConfidenceBreakdown, ConfidenceBand,
  StrategyName, RelativeStrengthFeatures, SectorContext,
} from '../types/signalEngine.types';
import { clamp, round } from '../utils/math';
import {
  CONFIDENCE_HIGH_CONVICTION, CONFIDENCE_ACTIONABLE, CONFIDENCE_WATCHLIST,
} from '../constants/signalEngine.constants';

function classifyBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_HIGH_CONVICTION) return 'High Conviction';
  if (score >= CONFIDENCE_ACTIONABLE) return 'Actionable';
  if (score >= CONFIDENCE_WATCHLIST) return 'Watchlist';
  return 'Avoid';
}

function buildBreakdown(
  trend: number, momentum: number, volume: number,
  structure: number, context: number, penalty: number,
): ConfidenceBreakdown {
  const rawScore = trend + momentum + volume + structure + context;
  const finalScore = clamp(Math.round(rawScore - penalty), 0, 100);
  return {
    trendScore: round(trend), momentumScore: round(momentum),
    volumeScore: round(volume), structureScore: round(structure),
    contextScore: round(context), rawScore: round(rawScore),
    penaltyScore: round(penalty), finalScore,
    band: classifyBand(finalScore),
  };
}

// ════════════════════════════════════════════════════════════════
//  BREAKOUT SCORER
//  Emphasis: Trend (30%) + Volume (25%) + Structure (20%) + RS (15%) + Context (10%)
// ════════════════════════════════════════════════════════════════
function scoreBreakout(
  f: SignalFeatures, rs: RelativeStrengthFeatures, sc: SectorContext,
): ConfidenceBreakdown {
  // Trend (max 30)
  let trend = 0;
  if (f.trend.closeAbove20Ema) trend += 8;
  if (f.trend.closeAbove50Ema) trend += 8;
  if (f.trend.ema20Above50) trend += 6;
  if (f.trend.closeAbove200Ema) trend += 4;
  if (f.trend.ema50Above200) trend += 2;
  if (f.momentum.adx >= 25) trend += 2;
  trend = Math.min(trend, 30);

  // Volume (max 25)
  let vol = 0;
  const vr = f.volume.volumeVs20dAvg;
  if (vr >= 2.5) vol += 15; else if (vr >= 2.0) vol += 12; else if (vr >= 1.5) vol += 9;
  if (f.volume.breakoutVolumeRatio >= 1.0) vol += 6; else if (f.volume.breakoutVolumeRatio >= 0.7) vol += 3;
  if (f.volume.obvSlope > 5) vol += 4;
  vol = Math.min(vol, 25);

  // Structure (max 20)
  let str = 0;
  const bd = f.structure.breakoutDistancePct;
  if (bd > 0 && bd <= 2) str += 12; else if (bd > 0 && bd <= 3.5) str += 8; else if (bd > 0 && bd <= 5) str += 5;
  if (f.structure.consecutiveHigherLows >= 3) str += 5; else if (f.structure.consecutiveHigherLows >= 2) str += 3;
  if (f.volatility.squeezed) str += 3;
  str = Math.min(str, 20);

  // RS & Sector (max 15)
  let rsScore = 0;
  if (rs.rsVsIndex > 3) rsScore += 7; else if (rs.rsVsIndex > 1) rsScore += 4; else if (rs.rsVsIndex > 0) rsScore += 2;
  if (sc.sectorStrengthScore >= 65) rsScore += 5; else if (sc.sectorStrengthScore >= 50) rsScore += 3;
  if (sc.sectorTrendLabel === 'Strong') rsScore += 3;
  rsScore = Math.min(rsScore, 15);

  // Context (max 10)
  let ctx = 0;
  if (f.context.marketRegime === 'Strong Bullish') ctx += 8; else if (f.context.marketRegime === 'Bullish') ctx += 6;
  if (f.context.liquidityPass) ctx += 2;
  ctx = Math.min(ctx, 10);

  // Penalties
  let penalty = 0;
  if (f.trend.distanceFrom20EmaPct > 5) penalty += 8; else if (f.trend.distanceFrom20EmaPct > 3) penalty += 4;
  if (f.volatility.atrPct > 4.5) penalty += 6;
  if (Math.abs(f.volatility.gapPct) > 2) penalty += 4;
  if (f.momentum.rsi14 > 76) penalty += 5;
  if (f.momentum.bearishDivergence) penalty += 6;
  if (rs.rsVsIndex < -3) penalty += 5;

  return buildBreakdown(trend, vol, str, rsScore, ctx, penalty);
}

// ════════════════════════════════════════════════════════════════
//  PULLBACK SCORER
//  Emphasis: Trend (30%) + Support Quality (25%) + Recovery (20%) + RS (15%) + Context (10%)
// ════════════════════════════════════════════════════════════════
function scorePullback(
  f: SignalFeatures, rs: RelativeStrengthFeatures, sc: SectorContext,
): ConfidenceBreakdown {
  // Trend structure (max 30)
  let trend = 0;
  if (f.trend.ema20Above50) trend += 10;
  if (f.trend.ema50Above200) trend += 8;
  if (f.trend.closeAbove200Ema) trend += 7;
  if (f.momentum.adx >= 20) trend += 3;
  if (f.structure.consecutiveHigherLows >= 2) trend += 2;
  trend = Math.min(trend, 30);

  // Support quality — pullback depth (max 25)
  let support = 0;
  const dist = Math.abs(f.trend.distanceFrom20EmaPct);
  if (dist <= 1.5 && dist >= 0) support += 15; // ideal: near EMA20
  else if (dist <= 3) support += 10;
  if (!f.trend.closeAbove20Ema && f.trend.closeAbove50Ema) support += 8; // between EMAs
  if (f.volume.volumeVs20dAvg < 1.0) support += 5; // volume contraction on pullback
  support = Math.min(support, 25);

  // Recovery confirmation (max 20)
  let recovery = 0;
  if (f.momentum.rsi14 >= 42 && f.momentum.rsi14 <= 55) recovery += 10;
  else if (f.momentum.rsi14 >= 38 && f.momentum.rsi14 <= 60) recovery += 6;
  if (f.momentum.macdHistogram > -0.3) recovery += 5; // MACD not deeply negative
  if (f.momentum.roc5 > -1) recovery += 5; // stabilizing
  recovery = Math.min(recovery, 20);

  // RS (max 15)
  let rsScore = 0;
  if (rs.rsVsIndex > 2) rsScore += 7; else if (rs.rsVsIndex > 0) rsScore += 4;
  if (sc.sectorStrengthScore >= 60) rsScore += 5; else if (sc.sectorStrengthScore >= 45) rsScore += 3;
  if (sc.sectorTrendLabel === 'Strong' || sc.sectorTrendLabel === 'Positive') rsScore += 3;
  rsScore = Math.min(rsScore, 15);

  // Context (max 10)
  let ctx = 0;
  if (f.context.marketRegime === 'Strong Bullish') ctx += 8;
  else if (f.context.marketRegime === 'Bullish') ctx += 6;
  else if (f.context.marketRegime === 'Sideways') ctx += 3;
  if (f.context.liquidityPass) ctx += 2;
  ctx = Math.min(ctx, 10);

  // Penalties
  let penalty = 0;
  if (f.trend.distanceFrom20EmaPct < -4) penalty += 8; // pullback too deep
  if (f.momentum.rsi14 < 35) penalty += 6; // too oversold for pullback
  if (f.volume.volumeVs20dAvg > 2.0) penalty += 5; // heavy volume = distribution
  if (f.momentum.macdHistogram < -1) penalty += 4;
  if (rs.rsVsIndex < -3) penalty += 5;

  return buildBreakdown(trend, support, recovery, rsScore, ctx, penalty);
}

// ════════════════════════════════════════════════════════════════
//  BREAKDOWN SCORER
//  Emphasis: Weakness (30%) + Structure Failure (25%) + Volume (20%) + RS (15%) + Context (10%)
// ════════════════════════════════════════════════════════════════
function scoreBreakdown(
  f: SignalFeatures, rs: RelativeStrengthFeatures, sc: SectorContext,
): ConfidenceBreakdown {
  // Weakness confirmation (max 30)
  let weakness = 0;
  if (!f.trend.closeAbove20Ema) weakness += 8;
  if (!f.trend.closeAbove50Ema) weakness += 8;
  if (!f.trend.closeAbove200Ema) weakness += 6;
  if (f.momentum.rsi14 < 40) weakness += 5; else if (f.momentum.rsi14 < 50) weakness += 3;
  if (f.momentum.macdHistogram < 0) weakness += 3;
  weakness = Math.min(weakness, 30);

  // Structure failure (max 25)
  let structFail = 0;
  if (f.structure.distanceToSupportPct < -2) structFail += 12; // well below support
  else if (f.structure.distanceToSupportPct < 0) structFail += 8;
  if (f.structure.consecutiveLowerHighs >= 3) structFail += 8;
  else if (f.structure.consecutiveLowerHighs >= 2) structFail += 4;
  if (!f.trend.ema20Above50) structFail += 5;
  structFail = Math.min(structFail, 25);

  // Volume on breakdown (max 20)
  let vol = 0;
  if (f.volume.volumeVs20dAvg >= 2.0) vol += 14; else if (f.volume.volumeVs20dAvg >= 1.5) vol += 10;
  else if (f.volume.volumeVs20dAvg >= 1.2) vol += 6;
  if (f.volume.obvSlope < -5) vol += 6; // OBV confirming distribution
  vol = Math.min(vol, 20);

  // Negative RS (max 15)
  let rsScore = 0;
  if (rs.rsVsIndex < -3) rsScore += 7; else if (rs.rsVsIndex < -1) rsScore += 4;
  if (sc.sectorStrengthScore <= 35) rsScore += 5; else if (sc.sectorStrengthScore <= 45) rsScore += 3;
  if (sc.sectorTrendLabel === 'Declining' || sc.sectorTrendLabel === 'Weak') rsScore += 3;
  rsScore = Math.min(rsScore, 15);

  // Context (max 10)
  let ctx = 0;
  if (f.context.marketRegime === 'Bearish') ctx += 8;
  else if (f.context.marketRegime === 'Weak') ctx += 6;
  else if (f.context.marketRegime === 'High Volatility Risk') ctx += 4;
  if (f.context.liquidityPass) ctx += 2;
  ctx = Math.min(ctx, 10);

  let penalty = 0;
  if (rs.rsVsIndex > 2) penalty += 6; // strong stock = breakdown unlikely
  if (f.momentum.rsi14 < 20) penalty += 5; // too oversold, may bounce
  if (sc.sectorStrengthScore >= 65) penalty += 5;

  return buildBreakdown(weakness, structFail, vol, rsScore, ctx, penalty);
}

// ════════════════════════════════════════════════════════════════
//  MEAN REVERSION SCORER
//  Emphasis: Oversold (30%) + Support (25%) + Reversal (25%) + RS (10%) + Context (10%)
//  Note: Lowest default weight (0.8) — most difficult to get high confidence
// ════════════════════════════════════════════════════════════════
function scoreMeanReversion(
  f: SignalFeatures, rs: RelativeStrengthFeatures, sc: SectorContext,
): ConfidenceBreakdown {
  let oversold = 0;
  if (f.momentum.rsi14 <= 25) oversold += 15; else if (f.momentum.rsi14 <= 30) oversold += 12;
  else if (f.momentum.rsi14 <= 35) oversold += 8; else if (f.momentum.rsi14 <= 40) oversold += 5;
  if (f.momentum.stochasticK < 20) oversold += 8; else if (f.momentum.stochasticK < 30) oversold += 5;
  if (f.volatility.bollingerPctB < 0.1) oversold += 7;
  oversold = Math.min(oversold, 30);

  let support = 0;
  const distLow = f.structure.recentLow20 > 0
    ? ((f.trend.close - f.structure.recentLow20) / f.structure.recentLow20) * 100 : 10;
  if (distLow <= 2) support += 15; else if (distLow <= 5) support += 10;
  if (f.trend.closeAbove200Ema) support += 7; // long-term structure intact
  if (f.structure.consecutiveHigherLows >= 1) support += 3;
  support = Math.min(support, 25);

  let reversal = 0;
  if (f.momentum.roc5 > -2 && f.momentum.roc5 < 2) reversal += 8; // stabilizing
  if (f.volume.volumeVs20dAvg >= 1.3) reversal += 7; // volume on bounce
  if (f.momentum.bullishDivergence) reversal += 10;
  reversal = Math.min(reversal, 25);

  let rsScore = 0;
  if (rs.rsVsIndex > -2) rsScore += 5;
  if (sc.sectorStrengthScore >= 45) rsScore += 5;
  rsScore = Math.min(rsScore, 10);

  let ctx = 0;
  if (f.context.marketRegime !== 'High Volatility Risk') ctx += 5;
  if (f.context.liquidityPass) ctx += 3;
  if (f.context.marketRegime === 'Sideways' || f.context.marketRegime === 'Bullish') ctx += 2;
  ctx = Math.min(ctx, 10);

  let penalty = 0;
  if (!f.trend.closeAbove200Ema && f.trend.distanceFrom50EmaPct < -10) penalty += 10; // structural damage
  if (f.momentum.roc5 < -5) penalty += 8; // still falling hard
  if (f.volatility.atrPct > 5) penalty += 5;

  return buildBreakdown(oversold, support, reversal, rsScore, ctx, penalty);
}

// ════════════════════════════════════════════════════════════════
//  Generic scorer for newer strategies (momentum, divergence, gap, climax)
// ════════════════════════════════════════════════════════════════
function scoreGeneric(
  f: SignalFeatures, rs: RelativeStrengthFeatures, sc: SectorContext,
  strategy: StrategyName,
): ConfidenceBreakdown {
  // Use the existing base scorer from confidenceScorer but add RS/sector
  const { scoreConfidence } = require('./confidenceScorer');
  const base: ConfidenceBreakdown = scoreConfidence(f);

  let adjustment = 0;

  // Strategy-specific RS/sector adjustments
  switch (strategy) {
    case 'momentum_continuation':
      if (f.momentum.adx >= 35) adjustment += 4;
      if (f.volume.obvSlope > 10) adjustment += 3;
      if (rs.rsVsIndex > 3) adjustment += 3;
      if (sc.sectorTrendLabel === 'Strong') adjustment += 2;
      break;
    case 'bullish_divergence':
      if (f.momentum.rsi14 <= 30) adjustment += 5;
      if (f.momentum.stochasticK < 25) adjustment += 3;
      if (sc.sectorStrengthScore >= 45) adjustment += 2;
      break;
    case 'volume_climax_reversal':
      if (f.volume.volumeClimaxRatio >= 4) adjustment += 5;
      if (f.momentum.rsi14 <= 25) adjustment += 4;
      break;
    case 'gap_continuation':
      if (f.volatility.gapPct >= 2 && f.volatility.gapPct <= 4) adjustment += 4;
      if (f.volume.volumeVs20dAvg >= 2) adjustment += 3;
      if (rs.rsVsIndex > 2) adjustment += 2;
      if (sc.sectorTrendLabel === 'Strong' || sc.sectorTrendLabel === 'Positive') adjustment += 2;
      break;
  }

  // RS context
  if (rs.sectorStrengthScore >= 65) adjustment += 2;
  if (rs.sectorStrengthScore <= 35) adjustment -= 3;

  const finalScore = clamp(base.finalScore + adjustment, 0, 100);
  return { ...base, finalScore, band: classifyBand(finalScore) };
}

// ════════════════════════════════════════════════════════════════
//  MASTER SCORER — Routes to strategy-specific scorer
// ════════════════════════════════════════════════════════════════
export function scoreForStrategy(
  features: SignalFeatures,
  strategy: StrategyName,
  rs: RelativeStrengthFeatures,
  sectorContext: SectorContext,
): ConfidenceBreakdown {
  switch (strategy) {
    case 'bullish_breakout':
      return scoreBreakout(features, rs, sectorContext);
    case 'bullish_pullback':
      return scorePullback(features, rs, sectorContext);
    case 'bearish_breakdown':
      return scoreBreakdown(features, rs, sectorContext);
    case 'mean_reversion_bounce':
      return scoreMeanReversion(features, rs, sectorContext);
    default:
      return scoreGeneric(features, rs, sectorContext, strategy);
  }
}
