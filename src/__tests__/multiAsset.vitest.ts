import { describe, expect, it } from 'vitest';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { buildCanonicalSignalFeatures } from '@/lib/platform/featureAdapters/featureAdapterRouter';
import { resolveAssetForSymbol, getAssetById } from '@/lib/platform/assetRegistry';
import { resolveMultiAssetConfig } from '@/lib/platform/multiAssetConfig';
import { computePositionSizeUnits, roundPriceForAsset } from '@/lib/platform/multiAssetRisk';
import { buildPortfolioContextReport } from '@/lib/platform/portfolioContext';
import { enrichOutcomeRecord, buildAllMultiAssetDimensions } from '@/lib/platform/analytics/multiAssetAnalytics';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';

function candles(n = 60, close = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: close,
    high: close + 2,
    low: close - 2,
    close: close + (i % 3) - 1,
    volume: 200_000,
  }));
}

describe('multi-asset platform', () => {
  it('preserves equity feature output when no asset specified', () => {
    const c = candles();
    const a = buildSignalFeatures(c, 'Bullish');
    const b = buildSignalFeatures(c, 'Bullish');
    expect(a.trend.close).toBe(b.trend.close);
    expect(a.context.liquidityPass).toBe(b.context.liquidityPass);
  });

  it('routes non-equity assets through adapters', () => {
    const crypto = getAssetById('CRYPTO:BTCUSD')!;
    const features = buildCanonicalSignalFeatures({
      asset: crypto,
      candles: candles(60, 50000),
      marketRegime: 'Bullish',
    });
    expect(features.trend).toBeDefined();
    expect(features.momentum).toBeDefined();
  });

  it('resolves versioned config overlays per asset', () => {
    const cfg = resolveMultiAssetConfig({ assetClass: 'crypto', strategyId: 'bullish_breakout' });
    expect(cfg.version).toBe('6.0.0');
    expect(cfg.effective.minAvgVolume).toBeLessThan(100_000);
  });

  it('computes multi-asset position sizing', () => {
    const asset = resolveAssetForSymbol('RELIANCE');
    const units = computePositionSizeUnits({
      asset,
      portfolioCapital: 1_000_000,
      riskPct: 1,
      entryPrice: 2500,
      stopPrice: 2450,
    });
    expect(units).toBeGreaterThan(0);
  });

  it('rounds prices per asset tick rules', () => {
    const eq = resolveAssetForSymbol('RELIANCE');
    expect(roundPriceForAsset(100.03, eq)).toBe(100.05);
  });

  it('builds portfolio context report only', () => {
    const report = buildPortfolioContextReport({
      positions: [
        { symbol: 'RELIANCE', assetClass: 'equity', sector: 'Energy', weight: 0.1, direction: 'long' },
        { symbol: 'TCS', assetClass: 'equity', sector: 'IT', weight: 0.08, direction: 'long' },
      ],
    });
    expect(report.sectorExposure.Energy).toBe(0.1);
    expect(report.concentrationScore).toBeGreaterThan(0);
  });

  it('extends analytics by asset class', () => {
    const record: OutcomeAnalyticsRecord = {
      signalId: 1,
      symbol: 'RELIANCE',
      strategy: 'bullish_breakout',
      sector: 'Energy',
      marketRegime: 'Bullish',
      timeframe: 'daily',
      generatedAt: '2026-01-11T00:00:00Z',
      predictedConfidence: 70,
      expectedRewardRisk: 1.5,
      outcome: {
        signalId: 1,
        entryTriggered: true,
        barsToEntry: 0,
        target1Hit: true,
        target2Hit: false,
        target3Hit: false,
        stopHit: false,
        maxFavorableExcursionPct: 5,
        maxAdverseExcursionPct: -1,
        pnlR: 1.2,
        returnAtBar5Pct: 3,
        returnAtBar10Pct: null,
        outcomeLabel: 'partial_success',
        evaluatedAt: '2026-01-12',
      },
    };
    const enriched = enrichOutcomeRecord(record);
    expect(enriched.assetClass).toBe('equity');
    const dims = buildAllMultiAssetDimensions([record]);
    expect(dims.assetClass.length).toBeGreaterThan(0);
  });
});
