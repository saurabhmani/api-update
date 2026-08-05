/**
 * Phase 10 — signal data-origin classification + live enrich rules.
 * Broker quote enrichment retired — warehouse via MarketDataProvider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
  getMarketStatus: vi.fn(() => ({ isOpen: true, label: 'OPEN' })),
}));

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(async () => ({
    userId: 7,
    provider: null,
    connection: null,
    connectionId: null,
    isConnected: false,
    isActiveDataSource: false,
    needsSelection: false,
    reason: 'none',
    connectedProviders: [],
    updatedAt: null,
  })),
}));

const getLiveSnapshot = vi.fn(async (sym: string) => ({
  data: {
    symbol: sym,
    ltp: 2500,
    price: 2500,
    changePercent: 0.8,
    timestamp: Date.now(),
  },
  fetched_at: Date.now(),
}));

vi.mock('@/providers/MarketDataProvider', () => ({
  getLiveSnapshot: (...args: unknown[]) =>
    getLiveSnapshot(args[0] as string),
}));

vi.mock('@/lib/marketData/resolver/marketDataResolver', () => ({
  resolveBatch: vi.fn(async () => ({
    provider: 'yahoo_emergency',
    snapshots: new Map([['RELIANCE', { price: 1, changePercent: 0, timestamp: Date.now() }]]),
    symbolsReturned: 1,
    symbolsRequested: 1,
    fallbackUsed: true,
  })),
}));

vi.mock('@/lib/marketData/liveFeedState', () => ({
  recordLiveFeedTick: vi.fn(),
}));

describe('dataOrigin helpers', () => {
  it('maps indianapi warehouse stamps and keeps legacy broker labels readable', async () => {
    const { liveOriginForBroker, buildSignalProvenance, originFromLiveSource } = await import(
      '@/lib/signals/dataOrigin'
    );
    expect(liveOriginForBroker('zerodha')).toBe('zerodha_live');
    expect(liveOriginForBroker('shoonya')).toBe('shoonya_live');
    expect(originFromLiveSource('indianapi_warehouse')).toBe('indianapi_warehouse');
    expect(originFromLiveSource('kite')).toBeNull();
    const p = buildSignalProvenance({
      generation: 'database',
      liveEnrichment: 'indianapi_warehouse',
    });
    expect(p.note).toMatch(/IndianAPI/i);
    expect(p.generation).toBe('database');
  });

  it('does not treat kite/yahoo liveSource as broker live', async () => {
    const { originFromLiveSource, dominantLiveOrigin } = await import(
      '@/lib/signals/dataOrigin'
    );
    expect(originFromLiveSource('kite')).toBeNull();
    expect(originFromLiveSource('yahoo')).toBe('fallback');
    expect(originFromLiveSource('zerodha_live')).toBe('zerodha_live');
    expect(
      dominantLiveOrigin([
        { liveSource: 'indianapi_warehouse', livePrice: 10 },
        { liveSource: 'fallback', livePrice: 11 },
      ]),
    ).toBe('indianapi_warehouse');
  });
});

describe('enrichWithLiveLtp Phase 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SIGNALS_LIVE_FALLBACK;
  });

  type LiveRow = {
    tradingsymbol: string;
    ltp: number;
    livePrice?: number | null;
    liveSource?: string | null;
  };

  it('fills from IndianAPI warehouse via MarketDataProvider', async () => {
    const { enrichWithLiveLtpDetailed } = await import(
      '@/lib/signals/confirmedSignalsService'
    );
    const rows: LiveRow[] = [{ tradingsymbol: 'RELIANCE', ltp: 2400 }];
    const result = await enrichWithLiveLtpDetailed(rows, { userId: 7 });
    expect(result.rows[0].livePrice).toBe(2500);
    expect(result.rows[0].liveSource).toBe('indianapi_warehouse');
    expect(result.liveOrigin).toBe('indianapi_warehouse');
    expect(result.fallbackUsed).toBe(false);
    expect(getLiveSnapshot).toHaveBeenCalled();
  });

  it('does not silently use Yahoo when warehouse miss and fallback disabled', async () => {
    getLiveSnapshot.mockRejectedValueOnce(new Error('miss'));
    const { enrichWithLiveLtpDetailed } = await import(
      '@/lib/signals/confirmedSignalsService'
    );
    const { resolveBatch } = await import(
      '@/lib/marketData/resolver/marketDataResolver'
    );
    const rows: LiveRow[] = [{ tradingsymbol: 'RELIANCE', ltp: 2400 }];
    const result = await enrichWithLiveLtpDetailed(rows, { userId: 7 });
    expect(result.rows[0].livePrice).toBeNull();
    expect(result.rows[0].liveSource).toBe('none');
    expect(result.fallbackUsed).toBe(false);
    expect(resolveBatch).not.toHaveBeenCalled();
  });

  it('uses fallback only when SIGNALS_LIVE_FALLBACK is enabled', async () => {
    process.env.SIGNALS_LIVE_FALLBACK = 'true';
    getLiveSnapshot.mockRejectedValueOnce(new Error('miss'));
    const { enrichWithLiveLtpDetailed } = await import(
      '@/lib/signals/confirmedSignalsService'
    );
    const rows: LiveRow[] = [{ tradingsymbol: 'RELIANCE', ltp: 2400 }];
    const result = await enrichWithLiveLtpDetailed(rows, { userId: 7 });
    expect(result.fallbackUsed).toBe(true);
    expect(result.rows[0].liveSource).toBe('fallback');
    expect(result.rows[0].livePrice).toBe(1);
  });
});
