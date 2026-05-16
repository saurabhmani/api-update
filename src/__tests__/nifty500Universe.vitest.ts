/**
 * NIFTY 500 universe loader contract tests (DB-backed).
 *
 *   §1 LOAD_DB      — initNifty500UniverseFromDb reads q365_universe
 *                     (is_active=1) and caches the dedup'd, uppercased
 *                     symbol list.
 *   §3 VALIDATION   — count must land in [NIFTY500_MIN_SIZE, MAX]; the
 *                     loader throws otherwise (no silent fallback).
 *   §6 MEMBERSHIP   — isInNifty500 / filterToNifty500 expose O(1) and
 *                     batch membership semantics over the cached set.
 *   §7 SYNC SAFETY  — sync getters throw when called before init.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @/lib/db so the loader hits an in-memory query function instead
// of a real MySQL pool. Each test sets `mockRows` to control the
// "result" of the SELECT.
let mockRows: Array<{ symbol: string }> = [];
vi.mock('@/lib/db', () => ({
  db: {
    query: vi.fn(async () => ({ rows: mockRows })),
  },
}));

import {
  loadNifty500Universe,
  isInNifty500,
  filterToNifty500,
  getNifty500Symbols,
  initNifty500UniverseFromDb,
  initOnce,
  isNifty500Initialized,
  _resetNifty500CacheForTests,
  _setNifty500CacheForTests,
  NIFTY500_MIN_SIZE,
  NIFTY500_MAX_SIZE,
} from '@/lib/marketData/nifty500Universe';

beforeEach(() => {
  _resetNifty500CacheForTests();
  mockRows = [];
});

afterEach(() => {
  _resetNifty500CacheForTests();
});

function makeRows(count: number): Array<{ symbol: string }> {
  const out: Array<{ symbol: string }> = [];
  for (let i = 0; i < count; i++) out.push({ symbol: `SYM${i}` });
  return out;
}

describe('nifty500Universe — DB load', () => {
  it('loads q365_universe rows with a count inside [MIN, MAX]', async () => {
    mockRows = makeRows(500);
    const u = await initNifty500UniverseFromDb();
    expect(u.symbols.length).toBe(500);
    expect(u.symbols.length).toBeGreaterThanOrEqual(NIFTY500_MIN_SIZE);
    expect(u.symbols.length).toBeLessThanOrEqual(NIFTY500_MAX_SIZE);
    expect(u.source).toBe('q365_universe(is_active=1)');
  });

  it('every symbol is uppercase and dedup', async () => {
    // Mix mixed-case + duplicates; loader must dedupe + uppercase.
    mockRows = [
      ...makeRows(498),
      { symbol: 'reliance' },
      { symbol: 'RELIANCE' },
      { symbol: '  tcs  ' },
    ];
    await initNifty500UniverseFromDb();
    const syms = getNifty500Symbols();
    const seen = new Set<string>();
    for (const s of syms) {
      expect(s).toBe(s.toUpperCase());
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(syms).toContain('RELIANCE');
    expect(syms).toContain('TCS');
  });

  it('idempotent — second call returns cached result without re-querying', async () => {
    mockRows = makeRows(490);
    const a = await initNifty500UniverseFromDb();
    const b = await initNifty500UniverseFromDb();
    expect(a).toBe(b); // same reference
  });

  it('membership: known symbols in, garbage out', async () => {
    _setNifty500CacheForTests(['RELIANCE', 'TCS', 'INFY']);
    expect(isInNifty500('RELIANCE')).toBe(true);
    expect(isInNifty500('reliance')).toBe(true);    // case-insensitive
    expect(isInNifty500('  RELIANCE  ')).toBe(true); // trim
    expect(isInNifty500('NOTASTOCK_XYZ')).toBe(false);
    expect(isInNifty500('')).toBe(false);
    expect(isInNifty500(null)).toBe(false);
  });

  it('filterToNifty500 drops non-members and dedupes', () => {
    _setNifty500CacheForTests(['RELIANCE', 'TCS']);
    const out = filterToNifty500(['RELIANCE', 'NOTASTOCK_XYZ', 'reliance', 'TCS']);
    expect(out).toEqual(['RELIANCE', 'TCS']);
  });
});

describe('nifty500Universe — validation', () => {
  it('throws when DB returns fewer than NIFTY500_MIN_SIZE symbols', async () => {
    mockRows = makeRows(100); // far below 480
    await expect(initNifty500UniverseFromDb()).rejects.toThrow(/minimum required is 480/);
  });

  it('throws when DB returns more than NIFTY500_MAX_SIZE symbols', async () => {
    mockRows = makeRows(NIFTY500_MAX_SIZE + 5);
    await expect(initNifty500UniverseFromDb()).rejects.toThrow(/maximum allowed is 550/);
  });

  it('throws when DB returns zero rows (table empty)', async () => {
    mockRows = [];
    await expect(initNifty500UniverseFromDb()).rejects.toThrow(/Refusing to boot/);
  });
});

describe('nifty500Universe — sync safety', () => {
  it('sync getters throw NIFTY500_UNIVERSE_NOT_INITIALIZED before init', () => {
    _resetNifty500CacheForTests();
    expect(() => loadNifty500Universe()).toThrow(/NIFTY500_UNIVERSE_NOT_INITIALIZED/);
    expect(() => getNifty500Symbols()).toThrow(/NIFTY500_UNIVERSE_NOT_INITIALIZED/);
    expect(() => isInNifty500('RELIANCE')).toThrow(/NIFTY500_UNIVERSE_NOT_INITIALIZED/);
    expect(() => filterToNifty500(['RELIANCE'])).toThrow(/NIFTY500_UNIVERSE_NOT_INITIALIZED/);
  });

  it('sync getters succeed once init has run', async () => {
    mockRows = makeRows(490);
    await initNifty500UniverseFromDb();
    expect(getNifty500Symbols().length).toBe(490);
    expect(isInNifty500('SYM0')).toBe(true);
  });

  it('isNifty500Initialized flips false → true around init', async () => {
    mockRows = makeRows(490);
    expect(isNifty500Initialized()).toBe(false);
    await initOnce();
    expect(isNifty500Initialized()).toBe(true);
  });
});

describe('nifty500Universe — race-safe init', () => {
  it('initOnce coalesces concurrent callers into one DB query', async () => {
    mockRows = makeRows(490);
    const { db } = await import('@/lib/db');
    const queryFn = (db.query as unknown) as ReturnType<typeof vi.fn>;
    queryFn.mockClear();

    // Fire 5 concurrent initOnce calls — they must all resolve to
    // the same result and only ONE DB query should land.
    const results = await Promise.all([
      initOnce(), initOnce(), initOnce(), initOnce(), initOnce(),
    ]);
    for (const r of results) expect(r.symbols.length).toBe(490);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('initOnce promise lock resets after a failed init so retry works', async () => {
    // First attempt: empty rows → throws.
    mockRows = [];
    await expect(initOnce()).rejects.toThrow(/Refusing to boot/);
    // Second attempt with a populated DB succeeds.
    mockRows = makeRows(485);
    const result = await initOnce();
    expect(result.symbols.length).toBe(485);
    expect(isNifty500Initialized()).toBe(true);
  });
});
