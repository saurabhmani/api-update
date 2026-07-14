// ════════════════════════════════════════════════════════════════
//  Fibonacci Reaction Confirmation — Product A Phase 5
// ════════════════════════════════════════════════════════════════

import type { Candle, MomentumFeatures, VolumeFeatures } from '../types/signalEngine.types';

export type FibConfirmationState = 'early_watchlist' | 'actionable_confirmation';

export interface FibReactionEvidence {
  bullishRejectionWick: boolean;
  bullishEngulfingOrStrongClose: boolean;
  higherLowAfterTouch: boolean;
  rsiTurningUp: boolean;
  macdHistogramImproving: boolean;
  volumeRecovery: boolean;
  breakAboveReactionHigh: boolean;
  evidenceCount: number;
  evidenceLabels: string[];
}

export function evaluateFibReaction(opts: {
  candles: Candle[];
  asOfIndex: number;
  level: number | null;
  momentum: MomentumFeatures;
  volume: VolumeFeatures;
  /** Prior RSI value when available on features trail — approximate via ROC. */
  rsiPrevApprox?: number | null;
  macdHistPrevApprox?: number | null;
}): FibReactionEvidence {
  const labels: string[] = [];
  const idx = opts.asOfIndex;
  const c = opts.candles[idx];
  const prev = idx > 0 ? opts.candles[idx - 1] : null;
  const range = c ? c.high - c.low : 0;

  const bullishRejectionWick =
    !!c &&
    range > 0 &&
    (Math.min(c.open, c.close) - c.low) / range >= 0.35 &&
    c.close > c.open &&
    (opts.level == null || c.low <= opts.level * 1.01);
  if (bullishRejectionWick) labels.push('rejection_wick');

  const bullishEngulfingOrStrongClose =
    !!c &&
    !!prev &&
    ((c.close > c.open && c.open <= prev.close && c.close >= prev.open && c.close > prev.open) ||
      (range > 0 && (c.close - c.low) / range >= 0.7 && c.close > c.open));
  if (bullishEngulfingOrStrongClose) labels.push('strong_close_or_engulfing');

  let higherLowAfterTouch = false;
  if (opts.level != null && idx >= 2) {
    const touched =
      opts.candles[idx - 1].low <= opts.level * 1.01 ||
      opts.candles[idx - 2].low <= opts.level * 1.01;
    higherLowAfterTouch = touched && c.low > opts.candles[idx - 1].low;
  }
  if (higherLowAfterTouch) labels.push('higher_low');

  const rsiTurningUp =
    opts.momentum.rsi14 >= 42 &&
    opts.momentum.rsi14 <= 65 &&
    (opts.rsiPrevApprox == null || opts.momentum.rsi14 > opts.rsiPrevApprox);
  if (rsiTurningUp) labels.push('rsi_turning_up');

  const macdHistogramImproving =
    opts.momentum.macdHistogram > 0 ||
    (opts.macdHistPrevApprox != null &&
      opts.momentum.macdHistogram > opts.macdHistPrevApprox);
  if (macdHistogramImproving) labels.push('macd_improving');

  const volumeRecovery = opts.volume.volumeVs20dAvg >= 1.0;
  if (volumeRecovery) labels.push('volume_recovery');

  // Conservative entry: close breaks above prior reaction candle high
  const reactionHigh = prev?.high ?? c?.high ?? 0;
  const breakAboveReactionHigh = !!c && c.close > reactionHigh && c.close > c.open;
  if (breakAboveReactionHigh) labels.push('break_reaction_high');

  const flags = [
    bullishRejectionWick,
    bullishEngulfingOrStrongClose,
    higherLowAfterTouch,
    rsiTurningUp,
    macdHistogramImproving,
    volumeRecovery,
    breakAboveReactionHigh,
  ];
  const evidenceCount = flags.filter(Boolean).length;

  return {
    bullishRejectionWick,
    bullishEngulfingOrStrongClose,
    higherLowAfterTouch,
    rsiTurningUp,
    macdHistogramImproving,
    volumeRecovery,
    breakAboveReactionHigh,
    evidenceCount,
    evidenceLabels: labels,
  };
}

/** Touch + weak reaction → early watchlist; ≥2 reaction evidences → actionable. */
export function resolveFibConfirmationState(
  zoneMatched: boolean,
  reaction: FibReactionEvidence,
  requireBreakForActionable = false,
): FibConfirmationState {
  if (!zoneMatched) return 'early_watchlist';
  const enough = reaction.evidenceCount >= 2;
  if (requireBreakForActionable) {
    return enough && reaction.breakAboveReactionHigh
      ? 'actionable_confirmation'
      : 'early_watchlist';
  }
  return enough ? 'actionable_confirmation' : 'early_watchlist';
}
