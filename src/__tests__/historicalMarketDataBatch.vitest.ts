import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: { query: vi.fn() },
}));

import { db } from '@/lib/db';
import {
  getHistoricalCandles,
  getHistoricalCandlesBatch,
  extractSymbolFromCandleInstrumentKey,
} from '@/lib/signals/historicalMarketData';

describe('getHistoricalCandlesBatch', () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset();
  });

  it('issues one query per chunk and groups rows by symbol', async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        {
          instrument_key: 'NSE_EQ|RELIANCE',
          ts: '2026-07-01',
          open: 100, high: 105, low: 99, close: 104, volume: 1000,
        },
        {
          instrument_key: 'NSE_EQ|TCS',
          ts: '2026-07-01',
          open: 200, high: 205, low: 198, close: 203, volume: 500,
        },
      ],
    } as any);

    const result = await getHistoricalCandlesBatch(
      ['RELIANCE', 'TCS', 'INFY'],
      '2026-07-01',
      '2026-07-01',
      '1day',
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = String(vi.mocked(db.query).mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('instrument_key IN');
    expect(sql).not.toContain('SUBSTRING_INDEX');
    expect(sql).not.toContain('DATE(ts)');
    expect(result.get('RELIANCE')?.available).toBe(true);
    expect(result.get('RELIANCE')?.candles).toHaveLength(1);
    expect(result.get('TCS')?.available).toBe(true);
    expect(result.get('INFY')?.available).toBe(false);
  });

  it('getHistoricalCandles delegates to batch for a single symbol', async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{
        instrument_key: 'NSE_EQ|HDFCBANK',
        ts: '2026-07-01',
        open: 1, high: 2, low: 1, close: 2, volume: 10,
      }],
    } as any);

    const r = await getHistoricalCandles('HDFCBANK', '2026-07-01', '2026-07-01', '1day');
    expect(r.available).toBe(true);
    expect(r.symbol).toBe('HDFCBANK');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('extractSymbolFromCandleInstrumentKey', () => {
  it('parses NSE_EQ pipe keys', () => {
    expect(extractSymbolFromCandleInstrumentKey('NSE_EQ|RELIANCE')).toBe('RELIANCE');
  });
});
