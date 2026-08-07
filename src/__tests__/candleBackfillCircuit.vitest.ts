// ════════════════════════════════════════════════════════════════
//  IndianAPI / NSE historical candle backfill — circuit & normalize
// ════════════════════════════════════════════════════════════════

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertIndianApiHistoricalCircuitAllows,
  classifyIndianApiCandleError,
  feedsIndianApiHistoricalCircuit,
  getIndianApiHistoricalCircuitConfig,
  getIndianApiHistoricalCircuitState,
  IndianApiCircuitOpenError,
  isIndianApiHistoricalCircuitOpen,
  noteIndianApiHistoricalSuccess,
  noteIndianApiHistoricalTransientFailure,
  resetIndianApiHistoricalCircuitForTests,
} from '@/lib/marketData/providers/indianApiHistoricalCircuit';
import {
  isUnsupportedEquitySeries,
  normalizeNseUniverseSymbol,
} from '@/lib/marketData/providers/nseSymbolNormalize';
import {
  fetchNseHistoricalCandles,
  getNseHistoricalState,
  isNseHistoricalCircuitOpen,
  resetNseHistoricalStateForTests,
} from '@/lib/marketData/providers/nseHistoricalProvider';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'INDIANAPI_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
  'INDIANAPI_CIRCUIT_BREAKER_COOLDOWN_SECONDS',
  'INDIANAPI_CIRCUIT_FAILURES',
  'INDIANAPI_CIRCUIT_COOLDOWN_MS',
  'INDIANAPI_503_MAX_RETRIES',
  'NSE_HISTORICAL_FETCH_ENABLED',
  'NSE_HISTORICAL_CIRCUIT_FAILURE_THRESHOLD',
  'NSE_HISTORICAL_CIRCUIT_COOLDOWN_SECONDS',
  'NSE_HISTORICAL_503_MAX_RETRIES',
  'NSE_HISTORICAL_MIN_GAP_MS',
  'NSE_HISTORICAL_DAILY_CAP',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  resetIndianApiHistoricalCircuitForTests();
  resetNseHistoricalStateForTests();
  process.env.INDIANAPI_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '3';
  process.env.INDIANAPI_CIRCUIT_BREAKER_COOLDOWN_SECONDS = '30';
  process.env.NSE_HISTORICAL_FETCH_ENABLED = 'true';
  process.env.NSE_HISTORICAL_CIRCUIT_FAILURE_THRESHOLD = '3';
  process.env.NSE_HISTORICAL_CIRCUIT_COOLDOWN_SECONDS = '30';
  process.env.NSE_HISTORICAL_503_MAX_RETRIES = '0';
  process.env.NSE_HISTORICAL_MIN_GAP_MS = '1';
  process.env.NSE_HISTORICAL_DAILY_CAP = '100';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetIndianApiHistoricalCircuitForTests();
  resetNseHistoricalStateForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeNseUniverseSymbol', () => {
  it('preserves original and provider symbols for -BE/-BZ', () => {
    const be = normalizeNseUniverseSymbol('KHAITANLTD-BE');
    expect(be.universeSymbol).toBe('KHAITANLTD-BE');
    expect(be.providerSymbol).toBe('KHAITANLTD');
    expect(be.series).toBe('BE');
    expect(be.isSpecialSeries).toBe(true);

    const bz = normalizeNseUniverseSymbol('FEL-BZ');
    expect(bz.providerSymbol).toBe('FEL');
    expect(bz.series).toBe('BZ');
    expect(bz.isSpecialSeries).toBe(true);
  });

  it('flags unsupported equity series for scan short-circuit', () => {
    expect(isUnsupportedEquitySeries('UNIDT-BE')).toBe(true);
    expect(isUnsupportedEquitySeries('SANWARIA-BZ')).toBe(true);
    expect(isUnsupportedEquitySeries('VALIANTORG-BE')).toBe(true);
    expect(isUnsupportedEquitySeries('RELIANCE')).toBe(false);
    expect(isUnsupportedEquitySeries('BAJAJ-AUTO')).toBe(false);
  });

  it('does not strip hyphenated EQ names without series', () => {
    const n = normalizeNseUniverseSymbol('BAJAJ-AUTO');
    expect(n.providerSymbol).toBe('BAJAJ-AUTO');
    expect(n.series).toBe('EQ');
    expect(n.seriesStripped).toBe(false);
  });

  it('treats plain EQ symbols as EQ series', () => {
    const n = normalizeNseUniverseSymbol('RELIANCE');
    expect(n.providerSymbol).toBe('RELIANCE');
    expect(n.series).toBe('EQ');
  });
});

describe('indianApiHistoricalCircuit', () => {
  it('one 503 does not open the breaker immediately', () => {
    const r = noteIndianApiHistoricalTransientFailure();
    expect(r.opened).toBe(false);
    expect(isIndianApiHistoricalCircuitOpen()).toBe(false);
    expect(getIndianApiHistoricalCircuitState().consecutiveFailures).toBe(1);
  });

  it('opens after configured consecutive transient failures', () => {
    expect(noteIndianApiHistoricalTransientFailure().opened).toBe(false);
    expect(noteIndianApiHistoricalTransientFailure().opened).toBe(false);
    const third = noteIndianApiHistoricalTransientFailure();
    expect(third.opened).toBe(true);
    expect(isIndianApiHistoricalCircuitOpen()).toBe(true);
    expect(getIndianApiHistoricalCircuitState().breakerTrips).toBe(1);
  });

  it('success resets the failure count', () => {
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalSuccess();
    expect(getIndianApiHistoricalCircuitState().consecutiveFailures).toBe(0);
    expect(noteIndianApiHistoricalTransientFailure().opened).toBe(false);
  });

  it('cooldown is short and configurable (not IST midnight)', () => {
    const cfg = getIndianApiHistoricalCircuitConfig();
    expect(cfg.cooldownMs).toBe(30_000);
    expect(cfg.failureThreshold).toBe(3);
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalTransientFailure();
    const st = getIndianApiHistoricalCircuitState();
    expect(st.open).toBe(true);
    expect(st.openUntilMs - Date.now()).toBeLessThanOrEqual(30_000 + 50);
    expect(st.openUntilMs - Date.now()).toBeGreaterThan(25_000);
  });

  it('local circuit-open assert does not pretend success and throws', () => {
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalTransientFailure();
    noteIndianApiHistoricalTransientFailure();
    expect(() => assertIndianApiHistoricalCircuitAllows()).toThrow(IndianApiCircuitOpenError);
    const before = getIndianApiHistoricalCircuitState().locallyBlockedRequests;
    try { assertIndianApiHistoricalCircuitAllows(); } catch { /* */ }
    expect(getIndianApiHistoricalCircuitState().locallyBlockedRequests).toBeGreaterThan(before);
  });

  it('unsupported / auth categories do not feed the breaker', () => {
    expect(feedsIndianApiHistoricalCircuit('unsupported_symbol_series')).toBe(false);
    expect(feedsIndianApiHistoricalCircuit('authentication_failed')).toBe(false);
    expect(feedsIndianApiHistoricalCircuit('symbol_not_found')).toBe(false);
    expect(feedsIndianApiHistoricalCircuit('transient_upstream_503')).toBe(true);
    expect(classifyIndianApiCandleError(new Error('HTTP 503'))).toBe('transient_upstream_503');
  });
});

describe('nseHistoricalProvider circuit (no IST midnight on 503)', () => {
  it('one 503 does not open circuit; threshold opens short cooldown', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    // Warm cookie path also uses fetch — return HTML home once then 503s.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html', getSetCookie: () => ['nseappid=x'] },
        text: async () => '',
      } as any);

    const r1 = await fetchNseHistoricalCandles('ANIKINDS-BE');
    expect(r1.ok).toBe(false);
    expect(r1.errorCode).toBe('HTTP_503');
    expect(isNseHistoricalCircuitOpen()).toBe(false);
    expect(r1.errorMessage ?? '').not.toMatch(/IST midnight/i);

    await fetchNseHistoricalCandles('AVADHSUGAR-BE');
    const r3 = await fetchNseHistoricalCandles('GOLDENTOBC-BZ');
    // After threshold (3) soft failures, circuit should open with short cooldown
    expect(isNseHistoricalCircuitOpen() || r3.tripped).toBe(true);
    const st = getNseHistoricalState();
    if (st.tripped_until) {
      const until = new Date(st.tripped_until).getTime();
      expect(until - Date.now()).toBeLessThan(60_000);
    }
  });

  it('local circuit-open rejections set locallyBlocked and skip upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Force-open by simulating threshold via successive soft fails with max retries 0
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => '',
    });
    // cookie refresh
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html', getSetCookie: () => ['nseappid=x'] },
      text: async () => '',
    } as any);

    await fetchNseHistoricalCandles('A-BE');
    await fetchNseHistoricalCandles('B-BE');
    await fetchNseHistoricalCandles('C-BE');
    const callsBefore = fetchMock.mock.calls.length;
    const blocked = await fetchNseHistoricalCandles('D-BE');
    expect(blocked.errorCode).toBe('CIRCUIT_OPEN');
    expect(blocked.locallyBlocked).toBe(true);
    // No additional upstream attempt beyond cookie (already warm)
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('normalizes -BE before request and does not trip on empty special series', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('nseindia.com/') && !String(url).includes('/api/')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/html', getSetCookie: () => ['nseappid=x'] },
          text: async () => '',
        };
      }
      expect(String(url)).toMatch(/symbol=KHAITANLTD/);
      expect(String(url)).toMatch(/BE/);
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ data: [] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchNseHistoricalCandles('KHAITANLTD-BE');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('UNSUPPORTED_SERIES');
    expect(isNseHistoricalCircuitOpen()).toBe(false);
    expect(r.providerSymbol).toBe('KHAITANLTD');
    expect(r.series).toBe('BE');
  });
});

describe('backfill pause semantics (unit)', () => {
  it('kite_requests label is removed from progress vocabulary (counters expose upstream_requests)', async () => {
    const { resetCandleSourceCounters, getCandleSourceCounters } = await import(
      '@/lib/marketData/candleFallbackChain'
    );
    resetCandleSourceCounters();
    const c = getCandleSourceCounters();
    expect(c).toHaveProperty('upstream_requests');
    expect(c.kite_requests).toBe(c.upstream_requests);
  });
});
