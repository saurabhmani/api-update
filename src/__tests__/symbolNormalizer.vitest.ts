import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  fromAny,
  fromManyToCanonical,
  isValidCanonical,
  toIndianApi,
  toNse,
  toYahoo,
} from '@/lib/marketData/symbolNormalizer';

describe('symbolNormalizer.fromAny', () => {
  it('uppercases and trims plain NSE tickers', () => {
    expect(fromAny('reliance')).toEqual({ exchange: 'NSE', symbol: 'RELIANCE' });
    expect(fromAny('  TCS\t')).toEqual({ exchange: 'NSE', symbol: 'TCS' });
  });

  it('strips Yahoo suffixes', () => {
    expect(fromAny('RELIANCE.NS')).toEqual({ exchange: 'NSE', symbol: 'RELIANCE' });
    expect(fromAny('reliance.bo')).toEqual({ exchange: 'NSE', symbol: 'RELIANCE' });
    expect(fromAny('RELIANCE.bse')).toEqual({ exchange: 'NSE', symbol: 'RELIANCE' });
  });

  it('preserves dashes and ampersands', () => {
    expect(fromAny('BAJAJ-AUTO').symbol).toBe('BAJAJ-AUTO');
    expect(fromAny('M&M').symbol).toBe('M&M');
    expect(fromAny('mcdowell-n').symbol).toBe('MCDOWELL-N');
  });

  it('routes 6-digit numeric input to BSE scrip-code form', () => {
    const c = fromAny('500325');
    expect(c.exchange).toBe('BSE');
    expect(c.symbol).toBe('500325');
    expect(c.bseCode).toBe('500325');
  });

  it('honours an explicit BSE hint', () => {
    expect(fromAny('RELIANCE', 'BSE')).toEqual({ exchange: 'BSE', symbol: 'RELIANCE' });
  });

  it('returns empty symbol for empty/junk input', () => {
    expect(fromAny('').symbol).toBe('');
    expect(fromAny('   ').symbol).toBe('');
  });
});

describe('symbolNormalizer adapters', () => {
  it('toIndianApi returns the bare ticker', () => {
    expect(toIndianApi(fromAny('reliance'))).toBe('RELIANCE');
  });

  it('toNse returns the bare ticker', () => {
    expect(toNse(fromAny('TCS'))).toBe('TCS');
  });

  it('toYahoo appends .NS for NSE and .BO for BSE', () => {
    expect(toYahoo(fromAny('RELIANCE'))).toBe('RELIANCE.NS');
    expect(toYahoo(fromAny('500325'))).toBe('500325.BO');
  });
});

describe('symbolNormalizer round-trip', () => {
  it('NSE round-trips cleanly across all providers', () => {
    const c = fromAny('reliance.ns');
    expect(canonicalKey(c)).toBe('NSE:RELIANCE');
    expect(toIndianApi(c)).toBe('RELIANCE');
    expect(toNse(c)).toBe('RELIANCE');
    expect(toYahoo(c)).toBe('RELIANCE.NS');
  });

  it('fromManyToCanonical dedupes by canonicalKey, preserving first-seen order', () => {
    const out = fromManyToCanonical(['RELIANCE', 'reliance', 'TCS', 'tcs.NS', 'TCS']);
    expect(out.map(canonicalKey)).toEqual(['NSE:RELIANCE', 'NSE:TCS']);
  });
});

describe('symbolNormalizer.isValidCanonical', () => {
  it('rejects empty symbols', () => {
    expect(isValidCanonical({ exchange: 'NSE', symbol: '' })).toBe(false);
  });

  it('accepts standard NSE tickers', () => {
    expect(isValidCanonical(fromAny('RELIANCE'))).toBe(true);
    expect(isValidCanonical(fromAny('BAJAJ-AUTO'))).toBe(true);
    expect(isValidCanonical(fromAny('M&M'))).toBe(true);
  });

  it('accepts BSE numeric scrip codes', () => {
    expect(isValidCanonical(fromAny('500325'))).toBe(true);
  });
});
