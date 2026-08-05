// ════════════════════════════════════════════════════════════════
//  IndianAPI flags + mappers — pure unit tests (no I/O, no mocks).
//
//  Covers:
//    • Provider resolution: explicit MARKET_DATA_PROVIDER always wins;
//      unset + INDIANAPI_ENABLED + key → bootstrap default indianapi;
//      unset + flag without key → none. Resolution is idempotent.
//    • validateEnv: indianapi selected without key errors in prod,
//      warns in dev; bootstrap misconfiguration warns.
//    • Mappers: vendor payload → canonical MarketSnapshot /
//      HistoricalSeries / MoversResult, with comma-string numerics,
//      NSE→BSE price preference, and derived absolute change.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  getSystemMarketDataProvider,
  getPrimaryFallbackProvider,
  isIndianApiBootstrapDefault,
  isIndianApiPrimary,
  getIndianApiIngestConfig,
} from '@/lib/marketData/providerFlags';
import { validateEnv } from '@/lib/validateEnv';
import {
  num,
  mapStockToSnapshot,
  mapBatchItemToSnapshot,
  mapStockToCorporateIntel,
  mapHistorical,
  mapTrendingToMovers,
  rangeToPeriod,
} from '@/lib/marketData/providers/indianApiMappers';

const ENV_KEYS = [
  'MARKET_DATA_PROVIDER',
  'INDIANAPI_ENABLED',
  'INDIANAPI_API_KEY',
  'INDIANAPI_KEY',
  'INDIAN_API_KEY',
  'INDIANAPI_OPTIONAL',
  'INDIANAPI_BATCH_ENABLED',
  'INDIANAPI_RPS_GLOBAL',
  'NODE_ENV',
] as const;

// Cast: NODE_ENV is typed read-only by Next's env typings; tests need
// to flip it to exercise the prod/dev validateEnv branches.
const env = process.env as Record<string, string | undefined>;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = env[k];
    delete env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete env[k];
    else env[k] = savedEnv[k];
  }
});

// ── Provider resolution ────────────────────────────────────────────

describe('providerFlags — indianapi resolution', () => {
  it('explicit MARKET_DATA_PROVIDER=kite resolves to none (unsupported)', () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'k';
    expect(getSystemMarketDataProvider()).toBe('none');
    expect(isIndianApiBootstrapDefault()).toBe(false);
    expect(isIndianApiPrimary()).toBe(false);
  });

  it('unset provider + flag on + key present → bootstrap default indianapi', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'k';
    expect(getSystemMarketDataProvider()).toBe('indianapi');
    expect(isIndianApiBootstrapDefault()).toBe(true);
    expect(isIndianApiPrimary()).toBe(true);
  });

  it('bootstrap resolution is idempotent (repeated calls, no state)', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'k';
    for (let i = 0; i < 5; i++) {
      expect(getSystemMarketDataProvider()).toBe('indianapi');
    }
  });

  it('unset provider + flag on WITHOUT key → none (no silent vendor)', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    expect(getSystemMarketDataProvider()).toBe('none');
    expect(isIndianApiBootstrapDefault()).toBe(false);
  });

  it('unset provider + flag off → none even with key present', () => {
    process.env.INDIANAPI_API_KEY = 'k';
    expect(getSystemMarketDataProvider()).toBe('none');
  });

  it('explicit indianapi selection works without the bootstrap flag', () => {
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    expect(getSystemMarketDataProvider()).toBe('indianapi');
    expect(isIndianApiBootstrapDefault()).toBe(false);
  });

  it('indianapi fallback chain is cache|db — never yahoo/kite', () => {
    expect(getPrimaryFallbackProvider('indianapi')).toBe('cache|db');
    expect(getPrimaryFallbackProvider('indianapi')).not.toContain('yahoo');
    expect(getPrimaryFallbackProvider('indianapi')).not.toContain('kite');
  });

  it('alternate key env names (INDIANAPI_KEY / INDIAN_API_KEY) satisfy credentials', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIAN_API_KEY = 'legacy-name';
    expect(getSystemMarketDataProvider()).toBe('indianapi');
  });

  it('ingest config clamps and defaults are sane', () => {
    const cfg = getIndianApiIngestConfig();
    expect(cfg.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(cfg.rpsGlobal).toBeGreaterThanOrEqual(1);
    expect(cfg.batchMode).toBe('auto');
    expect(cfg.perRunLimit).toBeGreaterThan(0);
    process.env.INDIANAPI_BATCH_ENABLED = 'off';
    expect(getIndianApiIngestConfig().batchMode).toBe('off');
    process.env.INDIANAPI_BATCH_ENABLED = 'on';
    expect(getIndianApiIngestConfig().batchMode).toBe('on');
  });
});

// ── validateEnv ────────────────────────────────────────────────────

describe('validateEnv — indianapi credential gates', () => {
  it('indianapi selected without key → hard error in production', () => {
    env.NODE_ENV = 'production';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    const result = validateEnv();
    expect(result.errors.some(e => e.includes('INDIANAPI_API_KEY'))).toBe(true);
  });

  it('indianapi selected without key → warning (not error) outside production', () => {
    env.NODE_ENV = 'test';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    const result = validateEnv();
    expect(result.errors.some(e => e.includes('INDIANAPI_API_KEY'))).toBe(false);
    expect(result.warnings.some(w => w.includes('INDIANAPI_API_KEY'))).toBe(true);
  });

  it('indianapi selected without INDIANAPI_ENABLED → feature-flag warning', () => {
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    process.env.INDIANAPI_API_KEY = 'k';
    const result = validateEnv();
    expect(result.warnings.some(w => w.includes('INDIANAPI_ENABLED'))).toBe(true);
  });

  it('bootstrap flag on without key → warning about resolving to none', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    const result = validateEnv();
    expect(result.warnings.some(w =>
      w.includes('resolves to none') || w.includes('INDIANAPI_API_KEY'),
    )).toBe(true);
  });
});

// ── Mappers ────────────────────────────────────────────────────────

describe('indianApiMappers', () => {
  it('num() tolerates comma-strings and junk', () => {
    expect(num('1,234.55')).toBe(1234.55);
    expect(num(42)).toBe(42);
    expect(num('n/a')).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(null)).toBe(0);
    expect(num('')).toBe(0);
  });

  it('mapStockToSnapshot prefers NSE price and derives absolute change', () => {
    const snap = mapStockToSnapshot('reliance', {
      companyName: 'Reliance Industries',
      currentPrice: { NSE: '2,955.60', BSE: '2,954.00' },
      percentChange: '1.25',
      previousClose: '2,919.10',
      open: '2,920.00',
      dayHigh: '2,960.00',
      dayLow: '2,910.00',
      volume: '5,000,000',
    });
    expect(snap.symbol).toBe('RELIANCE');
    expect(snap.price).toBe(2955.6);
    expect(snap.ltp).toBe(2955.6);
    expect(snap.change).toBeCloseTo(2955.6 - 2919.1, 6);
    expect(snap.changePercent).toBe(1.25);
    expect(snap.volume).toBe(5_000_000);
    expect(snap.prevClose).toBe(2919.1);
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('mapStockToSnapshot falls back to BSE when NSE is missing', () => {
    const snap = mapStockToSnapshot('X', { currentPrice: { BSE: 101.5 } });
    expect(snap.price).toBe(101.5);
  });

  it('mapBatchItemToSnapshot rejects unusable rows', () => {
    expect(mapBatchItemToSnapshot({ price: 10 })).toBeNull();          // no symbol
    expect(mapBatchItemToSnapshot({ symbol: 'ABC' })).toBeNull();      // no price
    const ok = mapBatchItemToSnapshot({ symbol: 'abc', lastPrice: '99.5' });
    expect(ok?.symbol).toBe('ABC');
    expect(ok?.price).toBe(99.5);
  });

  it('mapStockToCorporateIntel maps profile fields', () => {
    const intel = mapStockToCorporateIntel('TCS', {
      companyName: 'Tata Consultancy Services',
      sector: 'IT',
      industry: 'Software',
      marketCap: '1,400,000',
      peRatio: '29.4',
    });
    expect(intel.symbol).toBe('TCS');
    expect(intel.companyName).toBe('Tata Consultancy Services');
    expect(intel.sector).toBe('IT');
    expect(intel.pe).toBe(29.4);
  });

  it('rangeToPeriod maps canonical ranges to vendor periods', () => {
    expect(rangeToPeriod('1mo')).toBe('1m');
    expect(rangeToPeriod('6mo')).toBe('6m');
    expect(rangeToPeriod('1y')).toBe('1yr');
    expect(rangeToPeriod('5y')).toBe('5yr');
  });

  it('mapHistorical extracts the price dataset, sorts ascending, drops junk', () => {
    const series = mapHistorical('INFY', '1mo', {
      datasets: [
        {
          metric: 'Volume',
          values: [
            ['2026-07-01', 1_200_000],
            ['2026-07-02', 1_500_000],
            ['2026-07-04', 900_000],
          ],
        },
        {
          metric: 'Price',
          values: [
            ['2026-07-02', '1,510.5'],
            ['2026-07-01', 1500],
            ['bad-date', 1490],
            ['2026-07-03', 0],          // non-positive close dropped
            { date: '2026-07-04', value: 1520 },
          ],
        },
      ],
    });
    expect(series.symbol).toBe('INFY');
    expect(series.candles.map(c => c.c)).toEqual([1500, 1510.5, 1520]);
    expect(series.candles[0].t).toBeLessThan(series.candles[1].t);
    // Volume dataset is joined by date onto the price series.
    expect(series.candles[0].v).toBe(1_200_000);
    expect(series.candles[1].v).toBe(1_500_000);
    expect(series.candles[2].v).toBe(900_000);
  });

  it('mapTrendingToMovers builds gainers/losers/mostActive buckets', () => {
    const movers = mapTrendingToMovers(
      {
        trending_stocks: {
          top_gainers: [
            { ticker_id: 'abc', price: '10.5', percent_change: '4.2' },
            { company_name: 'No Symbol Row', price: 1 }, // dropped
          ],
          top_losers: [{ symbol: 'xyz', price: 99, percent_change: -2 }],
        },
      },
      [{ ric: 'mno', price: 55, percent_change: 0.5 }],
    );
    expect(movers.gainers).toHaveLength(1);
    expect(movers.gainers[0]).toMatchObject({ symbol: 'ABC', price: 10.5, changePercent: 4.2 });
    expect(movers.losers[0].symbol).toBe('XYZ');
    expect(movers.mostActive[0].symbol).toBe('MNO');
  });
});
