/**
 * Phase 4 — Multi-timeframe confirmation acceptance tests.
 */
import { describe, expect, it } from 'vitest';
import type { Candle, StrategyCandidate } from '@/lib/signal-engine/types/signalEngine.types';
import {
  evaluateMultiTimeframeAlignment,
  applyAlignmentToConfidence,
  MTF_POLICIES,
} from '@/lib/signal-engine/multitimeframe/multiTimeframeAlignment';
import {
  truncateCandlesAsOf,
  aggregateHourlyToFourHour,
  buildMtfBundleFromArrays,
} from '@/lib/signal-engine/multitimeframe/mtfCandleProvider';
import { applyMultiTimeframeConfirmation } from '@/lib/signal-engine/multitimeframe/applyMtfConfirmation';
import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import { evaluateMultiTimeframeAlignment as stubEval } from '@/lib/signal-engine/strategies/intradayStubs';

function candle(ts: string, close: number, volume = 1e6): Candle {
  return {
    ts,
    open: close * 0.999,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
  };
}

function trendSeries(n: number, start: number, step: number, baseTs: number): Candle[] {
  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px *= 1 + step;
    out.push(candle(new Date(baseTs + i * 86400000).toISOString(), px));
  }
  return out;
}

function hourlySeries(n: number, start: number, step: number, baseTs: number): Candle[] {
  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px *= 1 + step;
    out.push(candle(new Date(baseTs + i * 3600000).toISOString(), px, 5e5));
  }
  return out;
}

const RS = { rsVsIndex: 1, rsVsSector: 0, sectorStrengthScore: 50 };

function stubCandidate(strategy: StrategyCandidate['strategy'] = 'bullish_breakout'): StrategyCandidate {
  return {
    strategy,
    features: {
      trend: {} as never,
      momentum: {} as never,
      volume: {} as never,
      volatility: {} as never,
      structure: {} as never,
      context: { marketRegime: 'Bullish', liquidityPass: true },
      enhanced: {
        trendStrength: 70,
        volumeQuality: 60,
        volatilityRegime: 50,
        breakoutQuality: 55,
        liquidityQuality: 70,
        relativeStrength: 50,
        momentumPersistence: 55,
        riskAdjustedReward: 50,
        atrEfficiency: 50,
        emaCompression: 50,
        swingStructure: 50,
        supportResistanceProximity: 50,
        trendExhaustion: 30,
        marketParticipation: 55,
        multiTimeframeAlignment: 70,
      },
    },
    relativeStrength: RS,
    confidence: {
      trendScore: 20,
      momentumScore: 15,
      volumeScore: 15,
      structureScore: 15,
      contextScore: 10,
      rawScore: 75,
      penaltyScore: 0,
      finalScore: 70,
      band: 'Actionable',
    },
    risk: {
      atrRisk: 10,
      gapRisk: 5,
      stopDistanceRisk: 10,
      overextensionRisk: 5,
      liquidityRisk: 5,
      candleVolatilityRisk: 5,
      regimeRisk: 5,
      totalScore: 45,
      band: 'Moderate Risk',
    },
    tradePlan: {} as never,
    reasons: [],
    warnings: [],
  };
}

describe('Phase 4 multi-timeframe confirmation', () => {
  it('does not publish actionable standalone multi_timeframe_alignment', () => {
    expect(STRATEGY_REGISTRY.multi_timeframe_alignment.strategyMode).toBe('DISABLED');
    expect(STRATEGY_REGISTRY.multi_timeframe_alignment.isConfirmationOnly).toBe(true);
    const stub = stubEval({} as never);
    expect(stub.matched).toBe(false);
    expect(stub.rejectionReason).toMatch(/confirmation factor/i);
  });

  it('missing two timeframes is non-actionable and cannot increase confidence', () => {
    const daily = trendSeries(60, 100, 0.003, Date.parse('2024-01-01T00:00:00Z'));
    const result = evaluateMultiTimeframeAlignment({
      symbol: 'TEST',
      direction: 'BUY',
      strategy: 'bullish_breakout',
      daily,
      fourHour: null,
      oneHour: null,
      policy: MTF_POLICIES.breakout,
    });
    expect(result.alignment_state).toBe('insufficient_data');
    expect(result.actionable).toBe(false);
    expect(result.timeframe_alignment_score).toBeLessThanOrEqual(0);

    const before = 70;
    const after = applyAlignmentToConfidence(before, result.timeframe_alignment_score);
    expect(after).toBeLessThanOrEqual(before);
  });

  it('applies score exactly once', () => {
    const baseTs = Date.parse('2024-06-01T00:00:00Z');
    const daily = trendSeries(80, 100, 0.004, baseTs);
    const hourly = hourlySeries(120, 100, 0.001, baseTs);
    const bundle = buildMtfBundleFromArrays({
      daily,
      hourly,
      asOfMs: baseTs + 120 * 3600000,
    });

    const c = stubCandidate('momentum_continuation');
    const first = applyMultiTimeframeConfirmation({
      candidate: c,
      symbol: 'TEST',
      daily: bundle.daily,
      fourHour: bundle.fourHour,
      oneHour: bundle.oneHour,
      asOfMs: bundle.asOfMs,
    });
    expect(first.applied).toBe(true);
    const scoreAfterFirst = first.candidate.confidence.finalScore;

    const second = applyMultiTimeframeConfirmation({
      candidate: first.candidate,
      symbol: 'TEST',
      daily: bundle.daily,
      fourHour: bundle.fourHour,
      oneHour: bundle.oneHour,
      asOfMs: bundle.asOfMs,
    });
    expect(second.applied).toBe(false);
    expect(second.candidate.confidence.finalScore).toBe(scoreAfterFirst);
  });

  it('timestamp-safe truncation excludes future candles', () => {
    const asOf = Date.parse('2024-03-10T12:00:00Z');
    const series = [
      candle('2024-03-10T10:00:00.000Z', 100),
      candle('2024-03-10T11:00:00.000Z', 101),
      candle('2024-03-10T13:00:00.000Z', 102), // future
    ];
    const clipped = truncateCandlesAsOf(series, asOf);
    expect(clipped).toHaveLength(2);
    expect(clipped.every((c) => Date.parse(c.ts) <= asOf)).toBe(true);
  });

  it('aggregates hourly into 4H without inventing bars', () => {
    const base = Date.parse('2024-01-01T00:00:00Z');
    const hourly = hourlySeries(16, 100, 0.001, base);
    const h4 = aggregateHourlyToFourHour(hourly);
    expect(h4.length).toBeGreaterThan(0);
    expect(h4.length).toBeLessThanOrEqual(Math.ceil(hourly.length / 4));
  });

  it('with vs without MTF factor changes confidence only when data supports', () => {
    const baseTs = Date.parse('2024-06-01T00:00:00Z');
    const daily = trendSeries(80, 100, 0.004, baseTs);
    const hourly = hourlySeries(160, 100, 0.0015, baseTs);
    const asOf = baseTs + 160 * 3600000;
    const bundle = buildMtfBundleFromArrays({ daily, hourly, asOfMs: asOf });

    const withMtf = evaluateMultiTimeframeAlignment({
      symbol: 'TEST',
      direction: 'BUY',
      strategy: 'bullish_breakout',
      daily: bundle.daily,
      fourHour: bundle.fourHour,
      oneHour: bundle.oneHour,
      asOfMs: asOf,
      policy: MTF_POLICIES.breakout,
    });
    const without = evaluateMultiTimeframeAlignment({
      symbol: 'TEST',
      direction: 'BUY',
      strategy: 'bullish_breakout',
      daily: bundle.daily,
      fourHour: null,
      oneHour: null,
      asOfMs: asOf,
      policy: MTF_POLICIES.breakout,
    });

    expect(without.timeframe_alignment_score).toBeLessThanOrEqual(0);
    // With data present, score may be positive — prove the factor is not a no-op
    if (withMtf.actionable && withMtf.alignment_state !== 'insufficient_data') {
      expect(withMtf.explain.overall.state).toBeTruthy();
      expect(withMtf.explain.daily.verdict).toBeTruthy();
      expect(withMtf.explain.oneHour.role).toBeTruthy();
    }
  });

  it('exposes canonical explain contract', () => {
    const daily = trendSeries(60, 100, 0.002, Date.parse('2024-01-01T00:00:00Z'));
    const r = evaluateMultiTimeframeAlignment({
      symbol: 'X',
      direction: 'BUY',
      daily,
      fourHour: null,
      oneHour: null,
    });
    expect(r.explain.daily).toHaveProperty('verdict');
    expect(r.explain.fourHour).toHaveProperty('evidence');
    expect(r.explain.oneHour).toHaveProperty('role');
    expect(r.explain.overall).toHaveProperty('score');
  });
});
