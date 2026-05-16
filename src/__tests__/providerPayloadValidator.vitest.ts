// ════════════════════════════════════════════════════════════════
//  payloadValidator — provider per-row gate
//
//  Spec PROVIDER-NORMALIZE-2026-05: every adapter (IndianAPI, NSE,
//  Yahoo, …) must reject rows with price <= 0, volume <= 0 during
//  market hours, NaN/Infinity, and never let the row enter the
//  scoring pipeline. The validator is the single source of truth.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  validateMarketSnapshot,
  InvalidProviderPayloadError,
  assertValidSnapshot,
} from '@/lib/marketData/payloadValidator';

const validSnap = {
  symbol:        'RELIANCE',
  price:         2500,
  ltp:           2500,
  change:        25,
  changePercent: 1.0,
  volume:        100_000,
  open:          2480,
  high:          2510,
  low:           2470,
  prevClose:     2475,
  timestamp:     Date.now(),
};

describe('validateMarketSnapshot', () => {
  it('accepts a clean snapshot during market hours', () => {
    const r = validateMarketSnapshot(validSnap, { marketOpen: true });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('rejects price=0', () => {
    const r = validateMarketSnapshot({ ...validSnap, price: 0 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
  });

  it('rejects price=-1', () => {
    const r = validateMarketSnapshot({ ...validSnap, price: -1 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
  });

  it('rejects price=NaN', () => {
    const r = validateMarketSnapshot({ ...validSnap, price: NaN }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NOT_FINITE');
  });

  it('rejects price=Infinity', () => {
    const r = validateMarketSnapshot({ ...validSnap, price: Infinity }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NOT_FINITE');
  });

  it('rejects price=null', () => {
    const r = validateMarketSnapshot({ ...validSnap, price: null as any }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
  });

  it('rejects volume=0 during market hours', () => {
    const r = validateMarketSnapshot({ ...validSnap, volume: 0 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('VOLUME_ZERO_DURING_MARKET_HOURS');
  });

  it('accepts volume=0 outside market hours', () => {
    const r = validateMarketSnapshot({ ...validSnap, volume: 0 }, { marketOpen: false });
    expect(r.ok).toBe(true);
  });

  it('accepts volume=0 with allowZeroVolume override (cached/delayed)', () => {
    const r = validateMarketSnapshot({ ...validSnap, volume: 0 }, {
      marketOpen: true,
      allowZeroVolume: true,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects volume=NaN', () => {
    const r = validateMarketSnapshot({ ...validSnap, volume: NaN }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('VOLUME_NOT_FINITE');
  });

  it('rejects volume=-100', () => {
    const r = validateMarketSnapshot({ ...validSnap, volume: -100 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('VOLUME_NEGATIVE');
  });

  it('rejects changePercent=Infinity', () => {
    const r = validateMarketSnapshot({ ...validSnap, changePercent: Infinity }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('CHANGE_PCT_NOT_FINITE');
  });

  it('rejects empty symbol', () => {
    const r = validateMarketSnapshot({ ...validSnap, symbol: '' }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('SYMBOL_EMPTY');
  });

  it('rejects null snapshot', () => {
    const r = validateMarketSnapshot(null, { marketOpen: true });
    expect(r.ok).toBe(false);
  });

  it('multiple failures all surface', () => {
    const r = validateMarketSnapshot(
      { ...validSnap, price: 0, volume: 0, changePercent: NaN },
      { marketOpen: true },
    );
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
    expect(r.reasons).toContain('VOLUME_ZERO_DURING_MARKET_HOURS');
    expect(r.reasons).toContain('CHANGE_PCT_NOT_FINITE');
  });

  it('OHLC=0 is allowed (some plans don\'t expose intraday OHLC)', () => {
    const r = validateMarketSnapshot(
      { ...validSnap, open: 0, high: 0, low: 0 },
      { marketOpen: true },
    );
    expect(r.ok).toBe(true);
  });

  it('OHLC=NaN is rejected', () => {
    const r = validateMarketSnapshot(
      { ...validSnap, open: NaN },
      { marketOpen: true },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('OHLC_NOT_FINITE');
  });
});

describe('assertValidSnapshot', () => {
  it('returns the snapshot when valid', () => {
    expect(assertValidSnapshot('IndianAPI', validSnap, validSnap, { marketOpen: true })).toBe(validSnap);
  });

  it('throws InvalidProviderPayloadError when invalid', () => {
    expect(() => assertValidSnapshot(
      'IndianAPI',
      { ...validSnap, price: 0 },
      { ...validSnap, price: 0 },
      { marketOpen: true },
    )).toThrow(InvalidProviderPayloadError);
  });

  it('the thrown error carries provider, symbol, and reasons', () => {
    try {
      assertValidSnapshot(
        'NseDirect',
        { ...validSnap, symbol: 'AXISBANK', price: 0, volume: 0 },
        { foo: 'bar' },
        { marketOpen: true },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidProviderPayloadError);
      const err = e as InvalidProviderPayloadError;
      expect(err.provider).toBe('NseDirect');
      expect(err.symbol).toBe('AXISBANK');
      expect(err.reasons.length).toBeGreaterThanOrEqual(2);
    }
  });
});
