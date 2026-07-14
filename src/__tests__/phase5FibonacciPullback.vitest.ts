/**
 * Phase 5 — Fibonacci Pullback 2.0 acceptance tests.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import {
  selectConfirmedBullishImpulse,
  assertNoLookAheadInAnchors,
  findConfirmedPivots,
} from '@/lib/signal-engine/structure/confirmedSwingAnchors';
import { scoreFibonacciZoneQuality, fibTolerancePct } from '@/lib/signal-engine/structure/fibZoneQuality';
import { FIBONACCI_PULLBACK_VERSION } from '@/lib/signal-engine/strategies/fibonacciPullback';
import {
  evaluateFibReaction,
  resolveFibConfirmationState,
} from '@/lib/signal-engine/strategies/fibonacciReaction';
import { latestAtr } from '@/lib/signal-engine/indicators/atr';
import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import { compareFibBaselineVsV2 } from '@/lib/signal-engine/strategies/fibonacciBacktestCompare';

function c(ts: string, o: number, h: number, l: number, cl: number, v = 1e6): Candle {
  return { ts, open: o, high: h, low: l, close: cl, volume: v };
}

/** Build a clear swing-low → impulse → pullback series (confirmed pivots). */
function impulseThenPullback(): Candle[] {
  const out: Candle[] = [];
  const base = Date.parse('2024-01-01T00:00:00Z');
  const day = (i: number) => new Date(base + i * 86400000).toISOString();
  let i = 0;

  // Warmup — gentle chop around 100
  for (; i < 24; i++) {
    const wiggle = (i % 3) * 0.2;
    out.push(c(day(i), 100 + wiggle, 101 + wiggle, 99 + wiggle, 100 + wiggle, 8e5));
  }

  // Distinct swing low
  out.push(c(day(i++), 100, 100.5, 97.5, 98.5, 1.0e6));
  out.push(c(day(i++), 98.5, 99, 95, 96, 1.1e6)); // pivot low candidate
  out.push(c(day(i++), 96, 98, 95.5, 97.5, 1.0e6));
  out.push(c(day(i++), 97.5, 100, 97, 99.5, 1.2e6));

  // Impulse leg (strong directional advance)
  let px = 99.5;
  for (let k = 0; k < 18; k++) {
    const o = px;
    px = 99.5 + (k + 1) * 1.8;
    out.push(c(day(i++), o, px + 0.4, o - 0.15, px, 1.6e6));
  }

  // Local swing high + early fade so high confirms
  const high = px;
  out.push(c(day(i++), high, high + 0.6, high - 0.2, high + 0.2, 1.5e6));
  out.push(c(day(i++), high + 0.2, high + 0.3, high - 1.2, high - 0.8, 1.2e6));
  out.push(c(day(i++), high - 0.8, high - 0.4, high - 2.0, high - 1.5, 1.0e6));

  // Pullback toward Fib zone
  px = high - 1.5;
  for (let k = 0; k < 6; k++) {
    const o = px;
    px *= 0.988;
    out.push(c(day(i++), o, o + 0.25, px - 0.3, px, 7e5));
  }

  // Reaction candle (rejection wick)
  const o = px;
  out.push(c(day(i++), o, o * 1.012, o * 0.982, o * 1.008, 1.3e6));
  return out;
}

describe('Phase 5 Fibonacci Pullback 2.0', () => {
  it('keeps canonical strategy id — no duplicate Fib strategy', () => {
    expect(STRATEGY_REGISTRY.fibonacci_pullback.strategyId).toBe('fibonacci_pullback');
    expect(FIBONACCI_PULLBACK_VERSION).toBe('2.0.0');
    expect(Object.keys(STRATEGY_REGISTRY).some((k) => k.includes('fibonacci_early'))).toBe(false);
    expect(STRATEGY_REGISTRY.fibonacci_pullback.blockedRegimes).toEqual(
      expect.arrayContaining(['Sideways', 'Weak', 'Bearish', 'High Volatility Risk']),
    );
  });

  it('zero look-ahead bias: pivot confirmation never uses bars after asOf', () => {
    const candles = impulseThenPullback();
    for (let asOf = 40; asOf < candles.length; asOf++) {
      const atr = latestAtr(candles.slice(0, asOf + 1), 14);
      const { lows, highs } = findConfirmedPivots(candles, asOf, atr, {
        pivotLeft: 2,
        pivotConfirmDelay: 2,
        prominenceAtr: 0.35,
      });
      for (const p of [...lows, ...highs]) {
        expect(p.index + 2).toBeLessThanOrEqual(asOf);
        expect(p.index).toBeLessThanOrEqual(asOf);
      }
      const anchors = selectConfirmedBullishImpulse(candles, { asOfIndex: asOf });
      if (anchors) {
        expect(assertNoLookAheadInAnchors(anchors, asOf)).toBe(true);
      }
    }
  });

  it('records exact anchors and timestamps when impulse is valid', () => {
    const candles = impulseThenPullback();
    const anchors = selectConfirmedBullishImpulse(candles);
    expect(anchors).not.toBeNull();
    expect(anchors!.swingLow.ts).toBeTruthy();
    expect(anchors!.swingHigh.ts).toBeTruthy();
    expect(anchors!.swingHigh.price).toBeGreaterThan(anchors!.swingLow.price);
    expect(anchors!.impulseAtrMultiple).toBeGreaterThanOrEqual(1.5);
  });

  it('touch without reaction stays early_watchlist', () => {
    const reaction = {
      bullishRejectionWick: false,
      bullishEngulfingOrStrongClose: false,
      higherLowAfterTouch: false,
      rsiTurningUp: false,
      macdHistogramImproving: false,
      volumeRecovery: false,
      breakAboveReactionHigh: false,
      evidenceCount: 0,
      evidenceLabels: [],
    };
    expect(resolveFibConfirmationState(true, reaction)).toBe('early_watchlist');
  });

  it('volatility-aware tolerance is capped (not globally widened)', () => {
    expect(fibTolerancePct(1)).toBeLessThanOrEqual(1.25);
    expect(fibTolerancePct(10)).toBeLessThanOrEqual(1.25);
    expect(fibTolerancePct(0.5)).toBeGreaterThanOrEqual(0.45);
  });

  it('zone quality score is finite and bounded', () => {
    const candles = impulseThenPullback();
    const anchors = selectConfirmedBullishImpulse(candles)!;
    expect(anchors).toBeTruthy();
    const z = scoreFibonacciZoneQuality({
      close: candles[candles.length - 1].close,
      atr: anchors.atr,
      atrPct: (anchors.atr / candles[candles.length - 1].close) * 100,
      swingHigh: anchors.swingHigh.price,
      swingLow: anchors.swingLow.price,
      candles,
      fromIndex: anchors.swingLow.index,
      toIndex: candles.length - 1,
      trend: {
        ema20: candles[candles.length - 1].close * 0.99,
        ema50: candles[candles.length - 1].close * 0.97,
        close: candles[candles.length - 1].close,
      },
      volume: { volumeVs20dAvg: 1.1 },
      structure: {
        recentSupport20: anchors.swingLow.price,
        recentResistance20: anchors.swingHigh.price,
      },
    });
    expect(z.score).toBeGreaterThanOrEqual(0);
    expect(z.score).toBeLessThanOrEqual(100);
  });

  it('baseline vs Fib 2.0 comparison helper runs on frozen outcomes', () => {
    const report = compareFibBaselineVsV2([
      { regime: 'Bullish', baselineHit: true, v2Hit: true },
      { regime: 'Bullish', baselineHit: false, v2Hit: true },
      { regime: 'Sideways', baselineHit: true, v2Hit: false },
      { regime: 'Weak', baselineHit: false, v2Hit: false },
    ]);
    expect(report.regimes.length).toBeGreaterThanOrEqual(3);
    expect(report.sameFrozenN).toBe(4);
    expect(report.coversThreeRegimes).toBe(true);
  });

  it('reaction helper counts evidences', () => {
    const candles = impulseThenPullback();
    const r = evaluateFibReaction({
      candles,
      asOfIndex: candles.length - 1,
      level: candles[candles.length - 1].low * 1.001,
      momentum: {
        rsi14: 50,
        macdLine: 0,
        macdSignal: 0,
        macdHistogram: 0.1,
        roc5: 0,
        roc20: 0,
        stochasticK: 50,
        stochasticD: 50,
        adx: 25,
        bullishDivergence: false,
        bearishDivergence: false,
      },
      volume: {
        volume: 1e6,
        avgVolume20: 9e5,
        volumeVs20dAvg: 1.2,
        breakoutVolumeRatio: 1,
        obv: 0,
        obvSlope: 1,
        vwap: candles[candles.length - 1].close,
        volumeClimaxRatio: 1,
      },
    });
    expect(r.evidenceCount).toBeGreaterThanOrEqual(1);
  });
});
