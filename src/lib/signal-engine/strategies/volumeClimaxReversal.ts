// ════════════════════════════════════════════════════════════════
//  Volume Climax Reversal Strategy
//
//  Detects capitulation events where extreme volume on a down
//  day marks forced/panic selling — often precedes sharp reversals.
//  Requires: volume > 3x average + RSI extreme + bullish close.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import { VOLUME_CLIMAX_THRESHOLD } from '../constants/signalEngine.constants';

export function evaluateVolumeClimaxReversal(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Block in extreme volatility (capitulation can continue) ─
  if (context.marketRegime === 'High Volatility Risk') {
    return reject('Volume climax reversal too risky in extreme volatility');
  }

  // ── Volume climax: extreme volume spike ──────────────────
  if (volume.volumeClimaxRatio < VOLUME_CLIMAX_THRESHOLD) {
    return reject(`Volume not extreme enough: ${volume.volumeClimaxRatio}x (need ≥${VOLUME_CLIMAX_THRESHOLD}x)`);
  }

  // ── Must be in oversold territory ────────────────────────
  if (momentum.rsi14 > 35) {
    return reject(`RSI not in oversold territory: ${momentum.rsi14}`);
  }

  // ── Price near support (within 5% of recent low) ─────────
  const distFromLow = structure.recentLow20 > 0
    ? ((trend.close - structure.recentLow20) / structure.recentLow20) * 100
    : 0;
  if (distFromLow > 5) {
    return reject(`Price not near support: ${distFromLow.toFixed(1)}% above recent low`);
  }

  // ── Early bounce signal ──────────────────────────────────
  // ROC-5 should not be accelerating down hard
  if (momentum.roc5 < -8) {
    return reject('Still in freefall — no bounce signal yet');
  }

  // ── Stochastic in oversold zone ──────────────────────────
  if (momentum.stochasticK > 30) {
    return reject(`Stochastic not confirming oversold: ${momentum.stochasticK}`);
  }

  // ── Some structural support remaining ────────────────────
  // Not a total collapse — 200 EMA structure should show *some* support
  if (trend.distanceFrom50EmaPct < -15) {
    return reject('Structural damage too severe for reversal');
  }

  // ── Rejection filters ────────────────────────────────────
  if (volatility.atrPct > 7.0) return reject(`ATR% extreme: ${volatility.atrPct}`);
  if (Math.abs(volatility.gapPct) > 5.0) return reject(`Gap extreme: ${volatility.gapPct}%`);

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
