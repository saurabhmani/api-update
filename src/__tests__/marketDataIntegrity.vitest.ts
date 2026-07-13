import { describe, expect, it } from 'vitest';
import {
  validateCandleSeriesIntegrity,
  validateResolvedPriceIntegrity,
} from '@/lib/marketData/integrity/marketDataIntegrity';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';

const BASE: Candle = {
  ts: '2024-06-01',
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 1_000_000,
};

describe('market data integrity (Phase 1)', () => {
  it('rejects future timestamps', () => {
    const future = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);
    const r = validateCandleSeriesIntegrity([{ ...BASE, ts: future }], { nowMs: Date.now() });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'FUTURE_TIMESTAMP')).toBe(true);
  });

  it('rejects invalid OHLC', () => {
    const r = validateCandleSeriesIntegrity([{ ...BASE, high: 50 }]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_OHLC')).toBe(true);
  });

  it('dedupes duplicate timestamps keeping last bar', () => {
    const a = { ...BASE, close: 100 };
    const b = { ...BASE, close: 105 };
    const r = validateCandleSeriesIntegrity([a, b]);
    expect(r.valid).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0].close).toBe(105);
  });

  it('flags split-like jumps without failing by default', () => {
    const c1 = { ...BASE, ts: '2024-06-01', close: 100 };
    const c2 = { ...BASE, ts: '2024-06-02', close: 160 };
    const r = validateCandleSeriesIntegrity([c1, c2]);
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.code === 'SPLIT_ANOMALY')).toBe(true);
  });

  it('rejects LOW-quality resolver prices', () => {
    const r = validateResolvedPriceIntegrity({
      symbol: 'RELIANCE',
      price: 2500,
      ts: Date.now(),
      quality: 'LOW',
    });
    expect(r.valid).toBe(false);
  });
});
