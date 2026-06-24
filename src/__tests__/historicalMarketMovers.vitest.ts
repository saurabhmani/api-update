/**
 * getHistoricalMarketMovers — EOD candles → daily movers (Tests 1.1–1.5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: { query: (...args: unknown[]) => queryMock(...args) },
}));

import {
  extractSymbolFromCandleInstrumentKey,
  getHistoricalMarketMovers,
} from '@/lib/signals/historicalMarketData';

const TRADE_DATE = '2026-06-23';

function mockMoverRow(opts: {
  symbol: string;
  close: number;
  prev_close: number;
  volume?: number;
}) {
  const move_percent = ((opts.close - opts.prev_close) / opts.prev_close) * 100;
  return {
    instrument_key: `NSE_EQ|${opts.symbol}`,
    symbol: opts.symbol,
    close: opts.close,
    prev_close: opts.prev_close,
    volume: opts.volume ?? 0,
    move_percent,
  };
}

describe('extractSymbolFromCandleInstrumentKey — instrument_key parsing (Tests 2.1–2.3)', () => {
  it('2.1 — NSE|RELIANCE → RELIANCE', () => {
    expect(extractSymbolFromCandleInstrumentKey('NSE|RELIANCE')).toBe('RELIANCE');
  });

  it('2.2 — NSE|SBIN → SBIN', () => {
    expect(extractSymbolFromCandleInstrumentKey('NSE|SBIN')).toBe('SBIN');
  });

  it('2.3 — alternative warehouse format NSE_EQ|SYMBOL is documented and parsed', () => {
    // Production candles table uses NSE_EQ|{symbol}, not NSE|{symbol}.
    expect(extractSymbolFromCandleInstrumentKey('NSE_EQ|RELIANCE')).toBe('RELIANCE');
    expect(extractSymbolFromCandleInstrumentKey('NSE_EQ|SBIN')).toBe('SBIN');
    expect(extractSymbolFromCandleInstrumentKey('NSE_INDEX|NIFTY 50')).toBe('NIFTY 50');
  });

  it('uses the segment after the last pipe (SUBSTRING_INDEX parity)', () => {
    expect(extractSymbolFromCandleInstrumentKey('SEG|FOO|BAR')).toBe('BAR');
  });

  it('returns bare keys uppercased when no pipe is present', () => {
    expect(extractSymbolFromCandleInstrumentKey('reliance')).toBe('RELIANCE');
  });
});

describe('getHistoricalMarketMovers — Phase 4B', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('1.1 — candles for D and D-1 returns movers for date D', async () => {
    queryMock.mockResolvedValue({
      rows: [
        mockMoverRow({ symbol: 'RELIANCE', close: 110, prev_close: 100 }),
        mockMoverRow({ symbol: 'TCS', close: 90, prev_close: 100 }),
      ],
    });

    const result = await getHistoricalMarketMovers(TRADE_DATE);
    expect(result.date).toBe(TRADE_DATE);
    expect(result.movers.length).toBeGreaterThan(0);
    expect(result.movers.map((m) => m.symbol)).toEqual(['RELIANCE', 'TCS']);
    expect(queryMock).toHaveBeenCalledOnce();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/DATE\(curr\.ts\) = \?/);
    expect(sql).toMatch(/DATE\(p2\.ts\) < DATE\(curr\.ts\)/);
    expect(sql).toMatch(/SUBSTRING_INDEX\(curr\.instrument_key, '\|', -1\) AS symbol/);
    expect(queryMock.mock.calls[0][1]).toContain(TRADE_DATE);
  });

  it('1.2 — movePercent calculated correctly (prev 100, close 110 → 10%)', async () => {
    queryMock.mockResolvedValue({
      rows: [mockMoverRow({ symbol: 'RELIANCE', close: 110, prev_close: 100 })],
    });

    const result = await getHistoricalMarketMovers(TRADE_DATE);
    expect(result.movers[0].movePercent).toBe(10);
  });

  it('1.3 — direction is UP when close >= prev_close', async () => {
    queryMock.mockResolvedValue({
      rows: [
        mockMoverRow({ symbol: 'GAINER', close: 110, prev_close: 100 }),
        mockMoverRow({ symbol: 'FLAT', close: 100, prev_close: 100 }),
      ],
    });

    const result = await getHistoricalMarketMovers(TRADE_DATE);
    expect(result.movers.find((m) => m.symbol === 'GAINER')?.direction).toBe('UP');
    expect(result.movers.find((m) => m.symbol === 'FLAT')?.direction).toBe('UP');
    expect(result.movers.find((m) => m.symbol === 'FLAT')?.movePercent).toBe(0);
  });

  it('1.4 — direction is DOWN when close < prev_close', async () => {
    queryMock.mockResolvedValue({
      rows: [mockMoverRow({ symbol: 'LOSER', close: 90, prev_close: 100 })],
    });

    const result = await getHistoricalMarketMovers(TRADE_DATE);
    expect(result.movers[0].direction).toBe('DOWN');
    expect(result.movers[0].movePercent).toBe(-10);
  });

  it('1.5 — available is true when records exist', async () => {
    queryMock.mockResolvedValue({
      rows: [mockMoverRow({ symbol: 'RELIANCE', close: 110, prev_close: 100 })],
    });

    const result = await getHistoricalMarketMovers(TRADE_DATE);
    expect(result.available).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('1.6 — falls back to latest warehouse EOD when requested date has no bars', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ trade_date: TRADE_DATE }] })
      .mockResolvedValueOnce({
        rows: [mockMoverRow({ symbol: 'RELIANCE', close: 110, prev_close: 100 })],
      });

    const result = await getHistoricalMarketMovers('2026-06-24');
    expect(result.available).toBe(true);
    expect(result.date).toBe(TRADE_DATE);
    expect(result.movers).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });
});
