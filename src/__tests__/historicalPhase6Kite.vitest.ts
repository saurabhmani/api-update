/**
 * Phase 6 — historical candle pipeline via KiteAdapter.
 *
 * Covers interval mapping, Kite retrieval, empty/auth/rate-limit
 * failures, HistoricalSeries shape, and that upstream jobs call
 * fetchUpstreamDailyCandles (Kite-only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  kiteGetHistorical,
  kiteGetHistoricalByInterval,
  loadKiteConfig,
} = vi.hoisted(() => ({
  kiteGetHistorical: vi.fn(),
  kiteGetHistoricalByInterval: vi.fn(),
  loadKiteConfig: vi.fn(() => ({
    apiKey: 'k',
    apiSecret: 's',
    accessToken: 't',
    redirectUrl: '',
  })),
}));

vi.mock('@/lib/kite', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kite')>('@/lib/kite');
  return {
    ...actual,
    loadKiteConfig,
    getKiteClient: () => ({
      getAccessToken: () => 't',
      hydrateAccessTokenFromSession: async () => true,
      setAccessToken: vi.fn(),
    }),
  };
});

vi.mock('@/lib/kite/active-session-store', () => ({
  getActiveKiteAccessToken: vi.fn(async () => 't'),
  getActiveKiteSession: vi.fn(async () => null),
  saveActiveKiteSession: vi.fn(async () => undefined),
  clearActiveKiteSession: vi.fn(async () => true),
}));

vi.mock('@/providers/adapters/KiteAdapter', () => ({
  getHistorical: kiteGetHistorical,
  getHistoricalByInterval: kiteGetHistoricalByInterval,
}));

import {
  mapAppIntervalToKite,
  rangeToKiteWindow,
  chartIntervalToHistoricalRange,
  canonicalizeAppInterval,
  isIntradayAppInterval,
} from '@/lib/marketData/historicalIntervalMap';
import {
  getHistorical as kiteProviderHistorical,
} from '@/lib/marketData/providers/kiteHistoricalProvider';
import {
  fetchUpstreamDailyCandles,
  fetchKiteDailyCandles,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import { mapKiteHistoricalToSeries } from '@/providers/adapters/kite/mappers';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';
import type { HistoricalSeries } from '@/types/market';

function series(symbol = 'RELIANCE', n = 3): HistoricalSeries {
  const candles = Array.from({ length: n }, (_, i) => ({
    t: Date.UTC(2024, 0, i + 1),
    o: 100 + i,
    h: 110 + i,
    l: 90 + i,
    c: 105 + i,
    v: 1000 + i,
  }));
  return { symbol, range: '1y', candles };
}

beforeEach(() => {
  resetCandleSourceCounters();
  kiteGetHistorical.mockReset();
  kiteGetHistoricalByInterval.mockReset();
  loadKiteConfig.mockReturnValue({
    apiKey: 'k',
    apiSecret: 's',
    accessToken: '',
    redirectUrl: '',
  });
  process.env.KITE_API_KEY = 'k';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('historicalIntervalMap', () => {
  it('maps all app intervals used by the application', () => {
    expect(mapAppIntervalToKite('1m')).toBe('minute');
    expect(mapAppIntervalToKite('5m')).toBe('5minute');
    expect(mapAppIntervalToKite('15m')).toBe('15minute');
    expect(mapAppIntervalToKite('30m')).toBe('30minute');
    expect(mapAppIntervalToKite('60m')).toBe('60minute');
    expect(mapAppIntervalToKite('day')).toBe('day');
    expect(mapAppIntervalToKite('week')).toBe('day');
    expect(mapAppIntervalToKite('month')).toBe('day');
    expect(mapAppIntervalToKite('1minute')).toBe('minute');
    expect(mapAppIntervalToKite('1day')).toBe('day');
  });

  it('canonicalizes aliases', () => {
    expect(canonicalizeAppInterval('1m')).toBe('1minute');
    expect(canonicalizeAppInterval('day')).toBe('1day');
  });

  it('maps HistoricalRange windows', () => {
    const w = rangeToKiteWindow('1y');
    expect(w.interval).toBe('day');
    expect(w.from.getTime()).toBeLessThan(w.to.getTime());
    expect(rangeToKiteWindow('1d').interval).toBe('5minute');
  });

  it('maps chart intervals to HistoricalRange', () => {
    expect(chartIntervalToHistoricalRange('1day')).toBe('1y');
    expect(chartIntervalToHistoricalRange('1week')).toBe('5y');
    expect(chartIntervalToHistoricalRange('60minute')).toBe('3mo');
    expect(isIntradayAppInterval('5minute')).toBe(true);
    expect(isIntradayAppInterval('1day')).toBe(false);
  });
});

describe('HistoricalSeries mapping', () => {
  it('maps Kite candles into the canonical HistoricalSeries contract', () => {
    const out = mapKiteHistoricalToSeries('reliance', '1y', [
      {
        date: new Date('2024-01-02T00:00:00.000Z'),
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 100,
      },
    ]);
    expect(out).toEqual({
      symbol: 'RELIANCE',
      range: '1y',
      candles: [{ t: Date.parse('2024-01-02T00:00:00.000Z'), o: 10, h: 12, l: 9, c: 11, v: 100 }],
    });
  });
});

describe('kiteHistoricalProvider', () => {
  it('returns HistoricalSeries via KiteAdapter.getHistorical', async () => {
    kiteGetHistorical.mockResolvedValue(series());
    const inv = await kiteProviderHistorical('RELIANCE', '1y');
    expect(inv.status).toBe('success');
    expect(inv.provider).toBe('kite');
    expect(inv.data?.candles).toHaveLength(3);
    expect(inv.data?.candles[0]).toMatchObject({ t: expect.any(Number), o: expect.any(Number) });
  });

  it('maps empty response', async () => {
    kiteGetHistorical.mockResolvedValue({ symbol: 'RELIANCE', range: '1y', candles: [] });
    const inv = await kiteProviderHistorical('RELIANCE', '1y');
    expect(inv.status).toBe('failed');
    expect(inv.errorCode).toBe('EMPTY_RESPONSE');
  });

  it('maps authentication failure', async () => {
    kiteGetHistorical.mockRejectedValue(new KiteAuthenticationError('bad token'));
    const inv = await kiteProviderHistorical('RELIANCE', '1y');
    expect(inv.errorCode).toBe('KiteAuthenticationError');
  });

  it('maps rate limit failure', async () => {
    kiteGetHistorical.mockRejectedValue(new KiteRateLimitError('slow down'));
    const inv = await kiteProviderHistorical('RELIANCE', '1y');
    expect(inv.errorCode).toBe('KiteRateLimitError');
  });
});

describe('fetchUpstreamDailyCandles — Kite-only', () => {
  it('serves from Kite when available', async () => {
    kiteGetHistorical.mockResolvedValue(series('INFY', 2));
    const r = await fetchUpstreamDailyCandles('INFY', '1y');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('kite');
    expect(r.candles).toHaveLength(2);
  });

  it('returns Kite auth failure without secondary vendor', async () => {
    kiteGetHistorical.mockRejectedValue(new KiteAuthenticationError('auth'));
    const r = await fetchUpstreamDailyCandles('INFY', '1y');
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('kite');
    expect(r.errorCode).toBe('KiteAuthenticationError');
  });

  it('returns Kite rate-limit failure without secondary vendor', async () => {
    kiteGetHistorical.mockRejectedValue(new KiteRateLimitError('429'));
    const r = await fetchUpstreamDailyCandles('TCS', '1y');
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('kite');
    expect(r.errorCode).toBe('KiteRateLimitError');
  });

  it('returns empty Kite response without secondary vendor', async () => {
    kiteGetHistorical.mockResolvedValue({ symbol: 'TCS', range: '1y', candles: [] });
    const r = await fetchUpstreamDailyCandles('TCS', '1y');
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('kite');
    expect(r.errorCode).toBe('EMPTY_RESPONSE');
  });

  it('maps Kite-only fetch into engine candle shape', async () => {
    kiteGetHistorical.mockResolvedValue(series('RELIANCE', 1));
    const r = await fetchKiteDailyCandles('RELIANCE', '1y');
    expect(r.ok).toBe(true);
    expect(r.candles[0]).toMatchObject({
      ts: expect.any(String),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume: expect.any(Number),
    });
  });
});

describe('candle jobs contract', () => {
  it('backfill/daily jobs import fetchUpstreamDailyCandles (Kite-only)', async () => {
    const backfillSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../lib/marketData/candleBackfillJob.ts', import.meta.url),
        'utf8',
      ),
    );
    const dailySrc = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../lib/marketData/candleDailyUpdateJob.ts', import.meta.url),
        'utf8',
      ),
    );
    expect(backfillSrc).toMatch(/fetchUpstreamDailyCandles/);
    expect(dailySrc).toMatch(/fetchUpstreamDailyCandles/);
    expect(backfillSrc).not.toMatch(/fetchlegacy_vendorDailyCandles\(/);
    expect(dailySrc).not.toMatch(/fetchlegacy_vendorDailyCandles\(/);
    expect(backfillSrc).not.toMatch(/getlegacy_vendorConfig/);
    expect(dailySrc).not.toMatch(/getlegacy_vendorConfig/);
  });
});
