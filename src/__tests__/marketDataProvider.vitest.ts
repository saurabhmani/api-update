// ════════════════════════════════════════════════════════════════
//  MarketDataProvider — Phase-1 DoD test suite
//
//  Covers (architecture freeze):
//    • Fallback chain ordering (IndianAPI → cache → Yahoo → DB)
//    • Signal-critical stale rejection (StaleDataError thrown)
//    • Cache TTL hit path
//    • Canonical envelope fields — provider_name, source_type,
//      vendor_timestamp, freshness_ms, fallback_reason
//
//  Each test stubs the adapter modules so we can assert the
//  ordering and fall-through logic without any network.
// ════════════════════════════════════════════════════════════════

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every adapter module is mocked — we only want to test the provider.
vi.mock('@/providers/adapters/IndianAPIAdapter', () => ({
  getQuote: vi.fn(),
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
  getCorporateIntel: vi.fn(),
  getFundamentals: vi.fn(),
  getIndustryPeers: vi.fn(),
}));
vi.mock('@/providers/adapters/YahooAdapter', () => ({
  getQuote: vi.fn(),
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
  getCorporateIntel: vi.fn(),
  getIndustryPeers: vi.fn(),
}));

// Imports AFTER vi.mock so the mocked versions take effect.
import MarketDataProvider, { registerDbRepo } from '@/providers/MarketDataProvider';
import * as Indian from '@/providers/adapters/IndianAPIAdapter';
import * as Yahoo from '@/providers/adapters/YahooAdapter';
import { cache } from '@/lib/cache';
import { StaleDataError, type MarketSnapshot } from '@/types/market';
import { breaker } from '@/providers/resilience';

function makeSnap(symbol: string, price: number): MarketSnapshot {
  return {
    symbol, price, ltp: price,
    change: 0, changePercent: 0, volume: 100,
    open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

function resetBreakerFor(...providers: string[]): void {
  for (const p of providers) {
    void breaker.exec(p, async () => undefined).catch(() => undefined);
  }
}

describe('MarketDataProvider', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const sym of ['RELIANCE', 'TCS', 'INFY', 'X']) {
      await cache.del(`quote:${sym}`);
    }
    registerDbRepo({});
    resetBreakerFor('indian', 'yahoo');
  });

  // ── Chain ordering ────────────────────────────────────────────────

  it('IndianAPI is PRIMARY (source=indian, quality=near-live, source_type=primary)', async () => {
    vi.mocked(Indian.getQuote).mockResolvedValue(makeSnap('RELIANCE', 2501));
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.source).toBe('indian');
    expect(resp.data_quality).toBe('near-live');
    expect(resp.source_type).toBe('primary');
    expect(resp.provider_name).toBe('IndianAPI');
    expect(resp.fallback_reason).toBeNull();
    expect(resp.data.price).toBe(2501);
    expect(Yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('falls through IndianAPI → Yahoo when primary fails and cache is cold', async () => {
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('indian down'));
    vi.mocked(Yahoo.getQuote).mockResolvedValue(makeSnap('RELIANCE', 2498));
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.source).toBe('yahoo');
    expect(resp.data_quality).toBe('fallback-delayed');
    expect(resp.source_type).toBe('fallback');
    expect(resp.provider_name).toBe('Yahoo Finance');
    // fallback_reason should cite the IndianAPI failure
    expect(resp.fallback_reason).toContain('indian');
    expect(resp.trail?.some(t => t.source === 'indian' && !t.ok)).toBe(true);
    expect(resp.trail?.some(t => t.source === 'yahoo' && t.ok)).toBe(true);
  });

  it('serves from provider cache when primary fails on the second call', async () => {
    // First call populates cache via IndianAPI path.
    vi.mocked(Indian.getQuote).mockResolvedValueOnce(makeSnap('TCS', 4000));
    const first = await MarketDataProvider.getLiveSnapshot('TCS');
    expect(first.source).toBe('indian');

    // Now make Indian fail — cache should hit BEFORE Yahoo.
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('indian down'));
    const second = await MarketDataProvider.getLiveSnapshot('TCS');
    expect(second.source).toBe('cache');
    expect(second.data_quality).toBe('cached-fresh');
    expect(second.source_type).toBe('cache');
    expect(second.provider_name).toBe('Cache');
    expect(Yahoo.getQuote).not.toHaveBeenCalled();
  });

  // ── Stale / signal-critical behavior ─────────────────────────────

  it('throws StaleDataError when signalCritical=true and all upstreams fail', async () => {
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('indian fail'));
    vi.mocked(Yahoo.getQuote).mockRejectedValue(new Error('yahoo fail'));
    // No DB repo registered → provider has no last-known fallback.
    await expect(
      MarketDataProvider.getLiveSnapshot('INFY', { signalCritical: true }),
    ).rejects.toBeInstanceOf(StaleDataError);
  });

  it('serves from DB as last resort when non-critical', async () => {
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('indian fail'));
    vi.mocked(Yahoo.getQuote).mockRejectedValue(new Error('yahoo fail'));
    registerDbRepo({
      getQuote: async (sym) => makeSnap(sym, 999),
    });
    const resp = await MarketDataProvider.getLiveSnapshot('X');
    expect(resp.source).toBe('db');
    expect(resp.data_quality).toBe('stale');
    expect(resp.source_type).toBe('stale');
    expect(resp.provider_name).toBe('PostgreSQL');
    expect(resp.fallback_reason).toContain('indian');
    expect(resp.data.price).toBe(999);
  });

  it('DB hit still throws StaleDataError when signalCritical=true', async () => {
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('indian'));
    vi.mocked(Yahoo.getQuote).mockRejectedValue(new Error('yahoo'));
    registerDbRepo({
      getQuote: async (sym) => makeSnap(sym, 999),
    });
    await expect(
      MarketDataProvider.getLiveSnapshot('X', { signalCritical: true }),
    ).rejects.toBeInstanceOf(StaleDataError);
  });

  // ── Canonical envelope fields ────────────────────────────────────

  it('populates every canonical envelope field on a primary hit', async () => {
    const vendorTs = Date.now() - 250;
    vi.mocked(Indian.getQuote).mockResolvedValue({
      ...makeSnap('RELIANCE', 2501),
      timestamp: vendorTs,
    });
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');

    expect(resp.provider_name).toBe('IndianAPI');
    expect(resp.source_type).toBe('primary');
    expect(resp.source).toBe('indian');
    expect(resp.data_quality).toBe('near-live');
    expect(typeof resp.fetched_at).toBe('number');
    expect(resp.fetched_at).toBeGreaterThan(0);
    expect(resp.vendor_timestamp).toBe(vendorTs);
    expect(resp.freshness_ms).toBeGreaterThanOrEqual(0);
    expect(resp.freshness_ms).toBeLessThan(5_000);
    expect(resp.fallback_reason).toBeNull();
  });

  it('fallback_reason summarizes upstream failures when Yahoo serves', async () => {
    vi.mocked(Indian.getQuote).mockRejectedValue(new Error('429 rate limit'));
    vi.mocked(Yahoo.getQuote).mockResolvedValue(makeSnap('RELIANCE', 2498));
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.fallback_reason).not.toBeNull();
    expect(resp.fallback_reason).toContain('indian');
    expect(resp.fallback_reason).toContain('429');
  });
});
