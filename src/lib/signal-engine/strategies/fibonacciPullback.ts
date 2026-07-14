// ════════════════════════════════════════════════════════════════
//  Fibonacci Pullback 2.0 — Product A Phase 5
//
//  Canonical strategy id remains `fibonacci_pullback`.
//  Early watchlist vs actionable confirmation via lifecycle state —
//  NOT separate strategy identifiers.
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures,
  StrategyMatchResult,
  Candle,
  FibonacciPullbackSnapshot,
} from '../types/signalEngine.types';
import {
  selectConfirmedBullishImpulse,
  assertNoLookAheadInAnchors,
  type ConfirmedImpulseAnchors,
} from '../structure/confirmedSwingAnchors';
import {
  scoreFibonacciZoneQuality,
  fibTolerancePct,
  type FibZoneQualityResult,
} from '../structure/fibZoneQuality';
import {
  evaluateFibReaction,
  resolveFibConfirmationState,
  type FibConfirmationState,
  type FibReactionEvidence,
} from './fibonacciReaction';
import { formatFibLevelDisplay } from '../indicators/fibonacci';

export const FIBONACCI_PULLBACK_VERSION = '2.0.0';
export const MIN_ZONE_QUALITY_WATCHLIST = 40;
export const MIN_ZONE_QUALITY_ACTIONABLE = 52;
export const MIN_RR_ACCEPTABLE = 1.2;

export type { FibonacciPullbackSnapshot };

export interface FibonacciMatchResult extends StrategyMatchResult {
  confirmationState?: 'early_watchlist' | 'actionable_confirmation';
  fibonacciSnapshot?: FibonacciPullbackSnapshot;
}

/**
 * Optional candles for impulse/reaction. When absent, falls back to
 * structure fib levels (compat). Prefer passing candles from the pipeline.
 */
export function evaluateFibonacciPullback(
  features: SignalFeatures,
  candles?: Candle[] | null,
): FibonacciMatchResult {
  const { trend, momentum, volume, structure, context, volatility } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  let anchors: ConfirmedImpulseAnchors | null = null;
  const series =
    (candles && candles.length >= 40 ? candles : null) ??
    (features._sourceCandles && features._sourceCandles.length >= 40
      ? features._sourceCandles
      : null);
  if (series) {
    anchors = selectConfirmedBullishImpulse(series, {
      asOfIndex: series.length - 1,
    });
    if (anchors && !assertNoLookAheadInAnchors(anchors, series.length - 1)) {
      return reject('Swing anchor look-ahead guard failed');
    }
  }

  if (series) {
    if (!anchors || !anchors.valid) {
      return reject(
        anchors?.rejectReason
          ?? 'No valid ATR-confirmed bullish impulse for Fibonacci anchors',
      );
    }
  } else if (structure.fibZoneMatched !== true && !structure.fib50 && !structure.fib618) {
    return reject('Fibonacci structure levels unavailable');
  }

  const swingHigh = anchors?.swingHigh.price ?? structure.recentHigh20;
  const swingLow = anchors?.swingLow.price ?? structure.recentLow20;
  const atr = volatility.atr14;
  const atrPct = volatility.atrPct;

  const zone = scoreFibonacciZoneQuality({
    close: trend.close,
    atr,
    atrPct,
    swingHigh,
    swingLow,
    candles: series ?? [],
    fromIndex: anchors?.swingLow.index ?? 0,
    toIndex: series ? series.length - 1 : 0,
    trend,
    volume,
    structure,
    anchoredVwap: volume.vwap && Number.isFinite(volume.vwap) ? volume.vwap : null,
  });

  if (!zone.zoneMatched && zone.score < MIN_ZONE_QUALITY_WATCHLIST) {
    return reject(
      `Not in volatility-aware Fib zone (tol=${zone.tolerancePct}%, quality=${zone.score})`,
    );
  }

  if (!trend.ema20Above50) return reject('No uptrend: EMA20 not above EMA50');
  if (!trend.closeAbove200Ema) return reject('Price below 200 EMA — no long-term uptrend');

  const nearEma20 = trend.distanceFrom20EmaPct <= 1.5 && trend.distanceFrom20EmaPct >= -1.0;
  const betweenEmas = trend.closeAbove50Ema && !trend.closeAbove20Ema;
  const aboveBothEmas = trend.closeAbove20Ema && trend.closeAbove50Ema;
  if (!nearEma20 && !betweenEmas && !aboveBothEmas) {
    return reject(`Not supported by EMA structure: ${trend.distanceFrom20EmaPct.toFixed(1)}% from EMA20`);
  }

  if (momentum.rsi14 < 38) return reject(`RSI too weak: ${momentum.rsi14}`);
  if (momentum.rsi14 > 68) return reject(`RSI too hot for Fibonacci pullback: ${momentum.rsi14}`);

  if (volume.volumeVs20dAvg < 0.7) {
    return reject(`Volume too weak: ${volume.volumeVs20dAvg.toFixed(1)}x`);
  }

  const tol = zone.tolerancePct;
  const fib618 = zone.levels.fib618 ?? structure.fib618;
  const fib786 = zone.levels.fib786 ?? structure.fib786;
  if (fib618 != null && trend.close < fib618 * (1 - tol / 100)) {
    return reject('Price broke below 61.8% Fibonacci support');
  }
  if (fib786 != null && trend.close < fib786 * (1 - tol / 100)) {
    return reject('Price broke below 78.6% Fibonacci support');
  }

  if (anchors && trend.close < anchors.swingLow.price * 0.995) {
    return reject('Impulse swing-low anchor broken');
  }

  const asOf = series ? series.length - 1 : -1;
  const reaction: FibReactionEvidence = series
    ? evaluateFibReaction({
        candles: series,
        asOfIndex: asOf,
        level: zone.activeLevelPrice,
        momentum,
        volume,
      })
    : {
        bullishRejectionWick: false,
        bullishEngulfingOrStrongClose: false,
        higherLowAfterTouch: false,
        rsiTurningUp: momentum.rsi14 >= 42 && momentum.rsi14 <= 65,
        macdHistogramImproving: momentum.macdHistogram > 0,
        volumeRecovery: volume.volumeVs20dAvg >= 1.0,
        breakAboveReactionHigh: false,
        evidenceCount: 0,
        evidenceLabels: [],
      };

  if (!series) {
    const labels: string[] = [];
    if (reaction.rsiTurningUp) {
      reaction.evidenceCount++;
      labels.push('rsi_band');
    }
    if (reaction.macdHistogramImproving) {
      reaction.evidenceCount++;
      labels.push('macd');
    }
    if (reaction.volumeRecovery) {
      reaction.evidenceCount++;
      labels.push('volume');
    }
    reaction.evidenceLabels = labels;
  }

  const confirmationState = resolveFibConfirmationState(
    zone.zoneMatched,
    reaction,
    false,
  );

  const state: FibConfirmationState =
    confirmationState === 'actionable_confirmation' && zone.score >= MIN_ZONE_QUALITY_ACTIONABLE
      ? 'actionable_confirmation'
      : 'early_watchlist';

  if (
    zone.activeLevelPrice != null &&
    atr > 0 &&
    trend.close > zone.activeLevelPrice + 1.75 * atr &&
    state === 'early_watchlist'
  ) {
    return reject('Price extended too far beyond Fib zone without entry confirmation');
  }

  const invalidationLevel =
    anchors != null
      ? Math.min(anchors.swingLow.price, fib786 ?? anchors.swingLow.price) - 0.35 * atr
      : (fib786 ?? fib618 ?? null);

  if (!zone.zoneMatched && reaction.evidenceCount === 0) {
    return reject('No Fib zone touch and no reaction evidence');
  }

  const failureReasons = buildFailureReasons(zone, reaction, anchors, state);
  const snapshot = buildSnapshot(
    anchors,
    zone,
    state,
    reaction,
    invalidationLevel,
    failureReasons,
    swingHigh,
    swingLow,
  );

  return {
    matched: true,
    confirmationState: state,
    fibonacciSnapshot: snapshot,
  };
}

function buildSnapshot(
  anchors: ConfirmedImpulseAnchors | null,
  zone: FibZoneQualityResult,
  state: FibConfirmationState,
  reaction: FibReactionEvidence,
  invalidationLevel: number | null,
  failureReasons: string[],
  swingHigh: number,
  swingLow: number,
): FibonacciPullbackSnapshot {
  const explain = [
    `Swing low ${swingLow.toFixed(2)}${anchors ? ` @ ${anchors.swingLow.ts}` : ''}`,
    `Swing high ${swingHigh.toFixed(2)}${anchors ? ` @ ${anchors.swingHigh.ts}` : ''}`,
    anchors
      ? `Impulse ${anchors.impulseAtrMultiple}×ATR over ${anchors.impulseBars} bars (eff=${anchors.directionalEfficiency})`
      : 'Impulse anchors from structure lookback (legacy fallback)',
    zone.activeLevel
      ? `Active retracement ${formatFibLevelDisplay(zone.activeLevel)} @ ${zone.activeLevelPrice}`
      : 'No active retracement level',
    zone.distanceAtr != null ? `Distance ${zone.distanceAtr}×ATR (tol ${zone.tolerancePct}%)` : '',
    zone.confluences.length ? `Confluences: ${zone.confluences.join(', ')}` : 'No major confluences',
    `Reaction: ${reaction.evidenceLabels.join(', ') || 'none'} (${reaction.evidenceCount})`,
    `State: ${state}`,
    invalidationLevel != null ? `Invalidation ${invalidationLevel.toFixed(2)}` : '',
    `Zone quality ${zone.score}/100`,
  ].filter(Boolean);

  return {
    modelVersion: FIBONACCI_PULLBACK_VERSION,
    swingLowPrice: swingLow,
    swingHighPrice: swingHigh,
    swingLowTs: anchors?.swingLow.ts ?? '',
    swingHighTs: anchors?.swingHigh.ts ?? '',
    impulseAtrMultiple: anchors?.impulseAtrMultiple ?? 0,
    impulseBars: anchors?.impulseBars ?? 0,
    directionalEfficiency: anchors?.directionalEfficiency ?? 0,
    activeLevel: zone.activeLevel,
    activeLevelPrice: zone.activeLevelPrice,
    distanceAtr: zone.distanceAtr,
    zoneQualityScore: zone.score,
    tolerancePct: zone.tolerancePct,
    confluences: zone.confluences,
    confirmationState: state,
    reaction,
    invalidationLevel,
    failureReasons,
    explain,
  };
}

function buildFailureReasons(
  zone: FibZoneQualityResult,
  reaction: FibReactionEvidence,
  anchors: ConfirmedImpulseAnchors | null,
  state: FibConfirmationState,
): string[] {
  const reasons: string[] = [];
  if (state === 'early_watchlist') {
    reasons.push('Reaction confirmation incomplete — watchlist only until entry trigger');
  }
  if (zone.score < 60) reasons.push('Zone quality below preferred threshold');
  if (!reaction.volumeRecovery) reasons.push('Volume recovery not confirmed');
  if (anchors && anchors.chopRatio > 0.55) reasons.push('Impulse had elevated chop');
  if (zone.confluences.length === 0) reasons.push('Limited confluence at Fib level');
  reasons.push('Break of swing-low / Fib 78.6% invalidates the setup');
  reasons.push('Material regime shift to Bearish can void the pullback thesis');
  return reasons;
}

function reject(reason: string): FibonacciMatchResult {
  return { matched: false, rejectionReason: reason };
}

export { fibTolerancePct };
