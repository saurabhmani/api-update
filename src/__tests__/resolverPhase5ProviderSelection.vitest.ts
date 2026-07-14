/**
 * Phase 5 provider selection — kite primary (removed vendor removed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/marketData/providers/kiteHistoricalProvider', () => ({
  getHistorical: vi.fn(),
  isKiteHistoricalConfigured: () => true,
}));

vi.mock('@/lib/marketData/providers/nseDirectProvider', () => ({
  getNseDirectStatus: vi.fn(async () => ({ available: false })),
  fetchNseDirectQuote: vi.fn(),
}));

describe('resolver Phase 5 — kite primary', () => {
  beforeEach(() => {
    delete process.env.LEGACY_VENDOR_ENV;
    process.env.MARKET_DATA_PROVIDER = 'kite';
  });

  it('selects kite as MARKET_DATA_PROVIDER', async () => {
    const { getMarketDataProvider } = await import('@/lib/marketData/providerFlags');
    expect(getMarketDataProvider()).toBe('kite');
  });
});
