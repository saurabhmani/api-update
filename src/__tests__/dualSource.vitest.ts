// Dual-source pipeline unit tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateCrossSourceFeeds } from '@/lib/marketData/dualSource/feedValidator';
import { computeConfidenceScore } from '@/lib/marketData/dualSource/confidenceEngine';
import { evaluateApprovalGateway } from '@/lib/marketData/dualSource/approvalGateway';
import { processDualSourceSymbol } from '@/lib/marketData/dualSource/dataSourceManager';
import { _resetDualSourceMonitorForTests } from '@/lib/marketData/dualSource/monitoringService';
import type { NormalizedFeedTick } from '@/lib/marketData/dualSource/types';

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
}));

const CONFIG = {
  priceToleranceBps: 50,
  volumeTolerancePct: 25,
  timestampToleranceMs: 60_000,
  outlierSpikeBps: 200,
};

function tick(source: 'yahoo' | 'kite', ltp: number, ts = Date.now()): NormalizedFeedTick {
  return {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    source,
    ltp,
    open: ltp,
    high: ltp,
    low: ltp,
    close: ltp - 1,
    volume: 1_000_000,
    bid: null,
    ask: null,
    change: 1,
    changePercent: 0.1,
    sourceTimestamp: ts,
    receivedAt: ts,
    latencyMs: 100,
  };
}

describe('feedValidator', () => {
  it('confirms when both feeds agree', () => {
    const now = Date.now();
    const y = tick('yahoo', 2500, now);
    const i = tick('kite', 2501, now);
    const result = validateCrossSourceFeeds('RELIANCE', y, i, CONFIG, now);
    expect(result.status).toBe('confirmed');
    expect(result.metrics.priceDiffBps).toBeLessThan(50);
  });

  it('flags data_mismatch on severe divergence', () => {
    const now = Date.now();
    const y = tick('yahoo', 2500, now);
    const i = tick('kite', 3000, now);
    const result = validateCrossSourceFeeds('RELIANCE', y, i, CONFIG, now);
    expect(result.status).toBe('data_mismatch');
  });

  it('returns single_source when one feed missing', () => {
    const now = Date.now();
    const y = tick('yahoo', 2500, now);
    const result = validateCrossSourceFeeds('RELIANCE', y, null, CONFIG, now);
    expect(result.status).toBe('single_source');
  });

  it('returns no_reliable_data when both missing', () => {
    const result = validateCrossSourceFeeds('RELIANCE', null, null, CONFIG);
    expect(result.status).toBe('no_reliable_data');
  });
});

describe('confidenceEngine', () => {
  it('scores institutional when confirmed', () => {
    const now = Date.now();
    const validation = validateCrossSourceFeeds(
      'RELIANCE',
      tick('yahoo', 2500, now),
      tick('kite', 2500, now),
      CONFIG,
      now,
    );
    const { score, band } = computeConfidenceScore({
      validation,
      indicatorsAgree: true,
      trendConfirmed: true,
      liquidityOk: true,
      volatilityOk: true,
    }, now);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(['institutional', 'high']).toContain(band);
  });
});

describe('approvalGateway', () => {
  const approvalConfig = {
    allowSingleSourceSignals: false,
    authoritativeOnConflict: 'kite' as const,
    minConfidenceForSignal: 80,
  };

  it('approves confirmed feeds above confidence threshold', () => {
    const now = Date.now();
    const validation = validateCrossSourceFeeds(
      'RELIANCE',
      tick('yahoo', 2500, now),
      tick('kite', 2500, now),
      CONFIG,
      now,
    );
    const approval = evaluateApprovalGateway(validation, approvalConfig, now);
    expect(approval.allowed).toBe(true);
    expect(approval.status).toBe('approved');
  });

  it('holds on data mismatch', () => {
    const now = Date.now();
    const validation = validateCrossSourceFeeds(
      'RELIANCE',
      tick('yahoo', 2500, now),
      tick('kite', 3200, now),
      CONFIG,
      now,
    );
    const approval = evaluateApprovalGateway(validation, approvalConfig, now);
    expect(approval.allowed).toBe(false);
    expect(approval.status).toBe('held');
  });
});

describe('dataSourceManager.processDualSourceSymbol', () => {
  beforeEach(() => {
    _resetDualSourceMonitorForTests();
  });

  it('produces publish tick for confirmed pair', () => {
    const now = Date.now();
    const result = processDualSourceSymbol(
      'RELIANCE',
      tick('yahoo', 2500, now),
      tick('kite', 2500, now),
      now,
    );
    expect(result.validation.status).toBe('confirmed');
    expect(result.publishTick).not.toBeNull();
    expect(result.approval.allowed).toBe(true);
  });
});
