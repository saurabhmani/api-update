import { afterEach, describe, expect, it, vi } from 'vitest';

// We mock @/lib/db so the mapper's override-table loader is deterministic
// and doesn't require a live MySQL pool during the unit run.
vi.mock('@/lib/db', () => ({
  db: {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (/q365_symbol_mapping_override/.test(sql)) {
        return {
          rows: [
            { nse_symbol: 'OVERRIDDEN', api_symbol: 'OVERRIDDEN_API' },
          ],
        };
      }
      return { rows: [] };
    }),
  },
}));

import {
  mapToIndianApiSymbol,
  mapManyToIndianApiSymbol,
  _resetSymbolMapperCacheForTests,
} from '@/lib/marketData/symbolMapper';

afterEach(() => { _resetSymbolMapperCacheForTests(); });

describe('symbolMapper.mapToIndianApiSymbol', () => {
  it('trims and uppercases a clean ticker', async () => {
    expect(await mapToIndianApiSymbol(' reliance ')).toBe('RELIANCE');
  });

  it('strips Yahoo suffixes (.NS / .BO / .BSE)', async () => {
    expect(await mapToIndianApiSymbol('RELIANCE.NS')).toBe('RELIANCE');
    expect(await mapToIndianApiSymbol('reliance.bo')).toBe('RELIANCE');
    expect(await mapToIndianApiSymbol('RELIANCE.BSE')).toBe('RELIANCE');
  });

  it('preserves dashes and ampersands (default mapping passes through)', async () => {
    expect(await mapToIndianApiSymbol('BAJAJ-AUTO')).toBe('BAJAJ-AUTO');
    expect(await mapToIndianApiSymbol('M&M')).toBe('M&M');
    expect(await mapToIndianApiSymbol('L&TFH')).toBe('L&TFH');
  });

  it('honours an override-table row', async () => {
    expect(await mapToIndianApiSymbol('overridden')).toBe('OVERRIDDEN_API');
  });

  it('falls through to default when override missing and dictionary empty', async () => {
    expect(await mapToIndianApiSymbol('TCS')).toBe('TCS');
  });

  it('returns empty string for empty/junk input', async () => {
    expect(await mapToIndianApiSymbol('')).toBe('');
    expect(await mapToIndianApiSymbol('   ')).toBe('');
  });

  it('strips a stray BOM', async () => {
    expect(await mapToIndianApiSymbol('﻿RELIANCE')).toBe('RELIANCE');
  });
});

describe('symbolMapper.mapManyToIndianApiSymbol', () => {
  it('preserves input order', async () => {
    expect(await mapManyToIndianApiSymbol(['TCS', 'RELIANCE.NS', 'M&M']))
      .toEqual(['TCS', 'RELIANCE', 'M&M']);
  });

  it('honours overrides in batch form', async () => {
    expect(await mapManyToIndianApiSymbol(['overridden', 'TCS']))
      .toEqual(['OVERRIDDEN_API', 'TCS']);
  });
});
