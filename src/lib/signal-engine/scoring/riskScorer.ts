// ════════════════════════════════════════════════════════════════
//  Risk Scorer — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, RiskBreakdown, RiskBand } from '../types/signalEngine.types';
import { clamp, round } from '../utils/math';
import { RISK_LOW, RISK_MODERATE, RISK_ELEVATED } from '../constants/signalEngine.constants';

export function scoreRisk(features: SignalFeatures, stopDistancePct: number): RiskBreakdown {
  const atrRisk = scoreAtrRisk(features.volatility.atrPct);
  const gapRisk = scoreGapRisk(features.volatility.gapPct);
  const stopDistanceRisk = scoreStopDistance(stopDistancePct);
  const overextensionRisk = scoreOverextension(features.trend.distanceFrom20EmaPct);
  const liquidityRisk = features.context.liquidityPass ? 0 : 20;
  const candleVolatilityRisk = scoreCandleVolatility(features.volatility.dailyRangePct);
  const regimeRisk = scoreRegimeRisk(features.context.marketRegime);

  const totalScore = clamp(
    Math.round(
      atrRisk * 0.20 +
      gapRisk * 0.15 +
      stopDistanceRisk * 0.20 +
      overextensionRisk * 0.15 +
      liquidityRisk * 0.10 +
      candleVolatilityRisk * 0.10 +
      regimeRisk * 0.10
    ),
    0,
    100,
  );

  return {
    atrRisk: round(atrRisk),
    gapRisk: round(gapRisk),
    stopDistanceRisk: round(stopDistanceRisk),
    overextensionRisk: round(overextensionRisk),
    liquidityRisk,
    candleVolatilityRisk: round(candleVolatilityRisk),
    regimeRisk: round(regimeRisk),
    totalScore,
    band: classifyRisk(totalScore),
  };
}

function scoreAtrRisk(atrPct: number): number {
  if (atrPct > 5) return 90;
  if (atrPct > 4) return 70;
  if (atrPct > 3) return 50;
  if (atrPct > 2) return 30;
  return 15;
}

function scoreGapRisk(gapPct: number): number {
  const absGap = Math.abs(gapPct);
  if (absGap > 3) return 85;
  if (absGap > 2) return 60;
  if (absGap > 1) return 35;
  return 10;
}

function scoreStopDistance(stopDistancePct: number): number {
  if (stopDistancePct > 8) return 90;
  if (stopDistancePct > 6) return 70;
  if (stopDistancePct > 4) return 50;
  if (stopDistancePct > 2.5) return 30;
  return 15;
}

function scoreOverextension(distanceFrom20EmaPct: number): number {
  if (distanceFrom20EmaPct > 6) return 85;
  if (distanceFrom20EmaPct > 4) return 60;
  if (distanceFrom20EmaPct > 2.5) return 35;
  return 10;
}

function scoreCandleVolatility(dailyRangePct: number): number {
  if (dailyRangePct > 5) return 80;
  if (dailyRangePct > 3.5) return 55;
  if (dailyRangePct > 2) return 30;
  return 10;
}

function scoreRegimeRisk(regime: string): number {
  switch (regime) {
    case 'Strong Bullish': return 5;
    case 'Bullish': return 15;
    case 'Sideways': return 40;
    case 'Weak': return 65;
    case 'Bearish': return 80;
    case 'High Volatility Risk': return 90;
    default: return 50;
  }
}

function classifyRisk(score: number): RiskBand {
  if (score <= RISK_LOW) return 'Low Risk';
  if (score <= RISK_MODERATE) return 'Moderate Risk';
  if (score <= RISK_ELEVATED) return 'Elevated Risk';
  return 'High Risk';
}
