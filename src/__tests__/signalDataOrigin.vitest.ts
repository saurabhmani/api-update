/**
 * Phase 10 — signal data-origin classification + live enrich rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
  getMarketStatus: vi.fn(() => ({ isOpen: true, label: 'OPEN' })),
}));

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(async () => ({
    userId: 7,
    provider: 'shoonya',
    connection: { id: 'c1' },
    connectionId: 'c1',
    isConnected: true,
    isActiveDataSource: true,
    needsSelection: false,
    reason: 'primary',
    connectedProviders: ['shoonya'],
    updatedAt: null,
  })),
}));

const fetchQuote = vi.fn(async () => [
  {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    ltp: 2500,
    open: null,
    high: null,
    low: null,
    close: 2480,
    prevClose: 2480,
    volume: null,
    change: 20,
    changePercent: 0.8,
    asOfMs: Date.now(),
    quality: 'live' as const,
  },
]);

vi.mock('@/lib/marketData/brokerProvider', () => ({
  getBrokerMarketDataProvider: vi.fn(() => ({
    name: 'shoonya',
    connect: vi.fn(async () => undefined),
    fetchQuote,
  })),
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
  it('maps broker to live origin tags', async () => {
    const { liveOriginForBroker, buildSignalProvenance } = await import(
      '@/lib/signals/dataOrigin'
    );
    expect(liveOriginForBroker('zerodha')).toBe('zerodha_live');
    expect(liveOriginForBroker('shoonya')).toBe('shoonya_live');
    const p = buildSignalProvenance({
      generation: 'database',
      liveEnrichment: 'shoonya_live',
    });
    expect(p.note).toMatch(/Shoonya/);
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
        { liveSource: 'shoonya_live', livePrice: 10 },
        { liveSource: 'fallback', livePrice: 11 },
      ]),
    ).toBe('shoonya_live');
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

  it('uses Shoonya broker quotes for a Shoonya user and stamps shoonya_live', async () => {
    const { enrichWithLiveLtpDetailed } = await import(
      '@/lib/signals/confirmedSignalsService'
    );
    const rows: LiveRow[] = [{ tradingsymbol: 'RELIANCE', ltp: 2400 }];
    const result = await enrichWithLiveLtpDetailed(rows, { userId: 7 });
    expect(result.rows[0].livePrice).toBe(2500);
    expect(result.rows[0].liveSource).toBe('shoonya_live');
    expect(result.liveOrigin).toBe('shoonya_live');
    expect(result.fallbackUsed).toBe(false);
    expect(fetchQuote).toHaveBeenCalled();
  });

  it('does not silently use Yahoo/Kite when broker miss and fallback disabled', async () => {
    fetchQuote.mockResolvedValueOnce([]);
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
    fetchQuote.mockResolvedValueOnce([]);
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
