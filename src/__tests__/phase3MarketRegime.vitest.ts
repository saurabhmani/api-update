/**
 * Phase 3 — Advanced Market Regime acceptance tests.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import {
  detectEnhancedRegime,
  clearLastPublishedRegime,
  REGIME_MIN_CONFIRMATION_BARS,
} from '@/lib/signal-engine/regime/detectMarketRegime';
import { applyRegimeHysteresis } from '@/lib/signal-engine/regime/regimeHysteresis';
import {
  evaluateStrategyRegimeEligibility,
  deriveRegimeMatrix,
  STRATEGY_REGISTRY,
} from '@/lib/signal-engine/strategies/strategyRegistry';
import { buildRegimePerformanceReport } from '@/lib/signal-engine/regime/regimePerformanceReport';

function synthCandle(i: number, close: number, vol = 1_000_000): Candle {
  const open = close * 0.999;
  return {
    ts: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    open,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: vol,
  };
}

/** Sideways / range series — modest noise around flat mean. */
function sidewaysSeries(n = 120): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px = 100 + Math.sin(i / 5) * 0.4;
    out.push(synthCandle(i, px));
  }
  return out;
}

/** Strong uptrend series. */
function bullSeries(n = 120): Candle[] {
  const out: Candle[] = [];
  let px = 80;
  for (let i = 0; i < n; i++) {
    px *= 1.004;
    out.push(synthCandle(i, px));
  }
  return out;
}

describe('Phase 3 market regime engine', () => {
  beforeEach(() => {
    clearLastPublishedRegime();
  });

  it('returns structured dimensions + evidence + hysteresis (single contract)', () => {
    const r = detectEnhancedRegime(bullSeries());
    expect(r.modelVersion).toBe('3.0.0');
    expect(r.dimensions).toMatchObject({
      trend_state: expect.any(String),
      volatility_state: expect.any(String),
      breadth_state: expect.any(String),
      liquidity_state: expect.any(String),
      transition_state: expect.any(String),
    });
    expect(r.evidence.sourcesUnavailable).toContain('fii_dii');
    expect(r.evidence.sourcesUnavailable).toContain('derivatives_oi');
    expect(r.hysteresis).toBeDefined();
    expect(r.label).toBeTruthy();
  });

  it('does not oscillate excessively on a sideways sample', () => {
    clearLastPublishedRegime();
    const series = sidewaysSeries(150);
    const labels: string[] = [];
    // Walk forward in windows of growing length
    for (let end = 80; end < series.length; end++) {
      const slice = series.slice(0, end);
      const r = detectEnhancedRegime(slice);
      labels.push(r.label);
    }
    // Count flips
    let flips = 0;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i] !== labels[i - 1]) flips++;
    }
    // Sideways tape should not flip almost every bar
    expect(flips).toBeLessThan(labels.length * 0.25);
  });

  it('hysteresis requires confirmation bars before flip', () => {
    const h1 = applyRegimeHysteresis({
      candidateTrend: 'bull',
      candidateVol: 'normal',
      previousLabel: 'Sideways',
      previousDimensions: {
        trend_state: 'neutral',
        volatility_state: 'normal',
        breadth_state: 'selective',
        liquidity_state: 'healthy',
        transition_state: 'stable',
      },
      confirmationBarsHeld: 0,
      minConfirmationBars: REGIME_MIN_CONFIRMATION_BARS,
    });
    expect(h1.changed).toBe(false);
    expect(h1.changeReason).toMatch(/awaiting_confirmation/);

    const h2 = applyRegimeHysteresis({
      candidateTrend: 'bull',
      candidateVol: 'normal',
      previousLabel: 'Sideways',
      previousDimensions: h1.previousLabel
        ? {
            trend_state: 'neutral',
            volatility_state: 'normal',
            breadth_state: 'selective',
            liquidity_state: 'healthy',
            transition_state: 'stable',
          }
        : null,
      previousCandidateLabel: h1.candidateLabel,
      confirmationBarsHeld: h1.confirmationBarsHeld,
      minConfirmationBars: REGIME_MIN_CONFIRMATION_BARS,
    });
    expect(h2.changed).toBe(true);
  });

  it('strategy rejection identifies exact dimension and rule', () => {
    const result = evaluateStrategyRegimeEligibility('bullish_breakout', {
      label: 'Bearish',
      dimensions: {
        trend_state: 'strong_bear',
        volatility_state: 'normal',
        breadth_state: 'deteriorating',
        liquidity_state: 'healthy',
        transition_state: 'stable',
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.dimension).toBeTruthy();
    expect(result.rule).toBeTruthy();
    expect(result.reason).toMatch(/Bullish Breakout/);
  });

  it('registry is sole eligibility source — derive matrix covers all strategies', () => {
    for (const name of Object.keys(STRATEGY_REGISTRY) as Array<keyof typeof STRATEGY_REGISTRY>) {
      const matrix = deriveRegimeMatrix(STRATEGY_REGISTRY[name]);
      expect(matrix.nonIdealConfidencePenalty).toBeGreaterThanOrEqual(0);
      expect(matrix.ideal).toBeDefined();
      expect(matrix.allowed).toBeDefined();
      expect(matrix.blocked).toBeDefined();
    }
  });

  it('historical regime performance report aggregates by regime and transition', () => {
    const report = buildRegimePerformanceReport([
      { strategy: 'bullish_breakout', regimeLabel: 'Bullish', transitionState: 'stable', target1Hit: true, pnlR: 1 },
      { strategy: 'bullish_breakout', regimeLabel: 'Bullish', transitionState: 'stable', target1Hit: false, pnlR: -1 },
      { strategy: 'bullish_breakout', regimeLabel: 'Sideways', transitionState: 'emerging', target1Hit: true, pnlR: 0.5 },
    ]);
    expect(report.byRegime.length).toBeGreaterThanOrEqual(2);
    expect(report.byTransition.length).toBeGreaterThanOrEqual(2);
    expect(report.cells.some((c) => c.strategy === 'bullish_breakout')).toBe(true);
  });

  it('does not fabricate FII/DII when external evidence omitted', () => {
    const r = detectEnhancedRegime(bullSeries(), { external: null });
    expect(r.evidence.sourcesUnavailable).toEqual(
      expect.arrayContaining(['fii_dii', 'derivatives_oi']),
    );
    expect(r.evidence.advanceDeclineRatio).toBeNull();
  });
});
