import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/manipulation-engine/manipulationSignalRisk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manipulation-engine/manipulationSignalRisk')>();
  return {
    ...actual,
    computeManipulationFreshness: vi.fn().mockResolvedValue({
      latestEventDate: null,
      latestCandleDate: '2026-06-23',
      latestScanAt: null,
      latestTradingDate: '2026-06-23',
      isStale: false,
      daysLag: null,
      status: 'NO_DATA',
      reason: 'test',
      snapshotsPersisted30d: 0,
    }),
  };
});

import {
  fetchManipulationRiskForSignalPools,
  resolveManipulationSymbolsToQuery,
  buildManipulationRiskMeta,
  MANIPULATION_FALLBACK_SAMPLE_SIZE,
} from '@/lib/signals/manipulationRiskFetch';
import type { ManipulationRisk } from '@/lib/manipulation-engine/manipulationSignalRisk';

const UNIVERSE_25 = Array.from({ length: 25 }, (_, i) => `SYM${i + 1}`);

const unknownRisk = (): ManipulationRisk => ({
  score: null,
  band: 'UNKNOWN',
  freshnessStatus: 'NO_DATA',
  latestEventDate: null,
  latestScanAt: null,
  dominantPatterns: [],
  alertCount: 0,
  criticalCount: 0,
  recommendedAction: 'NO_IMPACT',
  canAffectApproval: false,
  explanation: '',
  evidence: [],
});

const riskWithSnapshot = (
  latestScanAt: string,
  freshnessStatus: ManipulationRisk['freshnessStatus'] = 'FRESH',
): ManipulationRisk => ({
  score: 55,
  band: 'ELEVATED',
  freshnessStatus,
  latestEventDate: '2026-06-19',
  latestScanAt,
  dominantPatterns: ['gap_fade'],
  alertCount: 1,
  criticalCount: 0,
  recommendedAction: 'WARNING_ONLY',
  canAffectApproval: false,
  explanation: '',
  evidence: [],
});

function mapForSymbols(
  symbols: string[],
  factory: (sym: string) => ManipulationRisk = () => unknownRisk(),
): Map<string, ManipulationRisk> {
  return new Map(symbols.map((sym) => [sym.toUpperCase(), factory(sym)]));
}

describe('resolveManipulationSymbolsToQuery', () => {
  it('1.3 — caps fallback universe to first 20 symbols', () => {
    const { symbolsToCheck, usedFallbackUniverse } = resolveManipulationSymbolsToQuery(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
    );
    expect(usedFallbackUniverse).toBe(true);
    expect(symbolsToCheck).toHaveLength(MANIPULATION_FALLBACK_SAMPLE_SIZE);
    expect(symbolsToCheck).toEqual(UNIVERSE_25.slice(0, 20));
    expect(symbolsToCheck).not.toContain('SYM21');
  });

  it('1.2 — uses signal symbols without fallback when rows exist', () => {
    const { symbolsToCheck, usedFallbackUniverse } = resolveManipulationSymbolsToQuery(
      {
        finalRows:           [{ symbol: 'RELIANCE' }],
        belowFloorDemoted:   [],
        inProgressEnriched:  [],
      },
      UNIVERSE_25,
    );
    expect(usedFallbackUniverse).toBe(false);
    expect(symbolsToCheck).toEqual(['RELIANCE']);
  });
});

describe('fetchManipulationRiskForSignalPools', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1.1 — invokes fetch when all signal pools are empty', async () => {
    const fetch = vi.fn().mockResolvedValue(new Map());
    await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(UNIVERSE_25.slice(0, 20));
  });

  it('1.2 — calls fetch with RELIANCE only when one signal row exists', async () => {
    const fetch = vi.fn().mockResolvedValue(new Map());
    const result = await fetchManipulationRiskForSignalPools(
      {
        finalRows:           [{ symbol: 'RELIANCE' }],
        belowFloorDemoted:   [],
        inProgressEnriched:  [],
      },
      UNIVERSE_25,
      fetch,
    );
    expect(fetch).toHaveBeenCalledWith(['RELIANCE']);
    expect(result.manipulationUsedFallbackUniverse).toBe(false);
  });

  it('1.3 — passes only first 20 universe symbols on empty pools', async () => {
    const fetch = vi.fn().mockResolvedValue(new Map());
    await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );
    const calledWith = fetch.mock.calls[0]?.[0] as string[];
    expect(calledWith).toHaveLength(20);
    expect(calledWith[0]).toBe('SYM1');
    expect(calledWith[19]).toBe('SYM20');
  });

  it('1.4 — degrades gracefully when fetch throws (API path would continue)', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const warnSpy = vi.spyOn(console, 'warn');

    const result = await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );

    expect(result.manipulationRiskMap).toBeUndefined();
    expect(result.manipulationUsedFallbackUniverse).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[api/signals] manipulation risk fetch failed:',
      expect.any(Error),
    );
    // fetchManipulationRiskForSignalPools never throws — caller can still return 200.
    await expect(
      fetchManipulationRiskForSignalPools(
        { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
        UNIVERSE_25,
        fetch,
      ),
    ).resolves.toBeDefined();
  });
});

describe('buildManipulationRiskMeta', () => {
  it('returns configured=false when map is missing', () => {
    expect(buildManipulationRiskMeta(undefined)).toEqual({
      configured: false,
      symbolCount: 0,
      snapshotCount: 0,
      freshestSnapshotAt: null,
      stale: false,
      globalSnapshotCount: 0,
      globalLatestScanAt: null,
    });
  });

  it('derives snapshotCount and freshestSnapshotAt from scanner output only', () => {
    const map = new Map<string, ManipulationRisk>([
      ['RELIANCE', {
        score: 40, band: 'WATCH', freshnessStatus: 'FRESH',
        latestScanAt: '2026-06-20T10:00:00.000Z', latestEventDate: '2026-06-19',
        dominantPatterns: [], alertCount: 1, criticalCount: 0,
        recommendedAction: 'WARNING_ONLY', canAffectApproval: false,
        explanation: '', evidence: [],
      }],
      ['TCS', {
        score: null, band: 'UNKNOWN', freshnessStatus: 'NO_DATA',
        latestScanAt: null, latestEventDate: null,
        dominantPatterns: [], alertCount: 0, criticalCount: 0,
        recommendedAction: 'NO_IMPACT', canAffectApproval: false,
        explanation: '', evidence: [],
      }],
    ]);
    expect(buildManipulationRiskMeta(map)).toEqual({
      configured: true,
      symbolCount: 2,
      snapshotCount: 1,
      freshestSnapshotAt: '2026-06-20T10:00:00.000Z',
      stale: false,
      globalSnapshotCount: 0,
      globalLatestScanAt: null,
    });
  });

  it('marks stale=true when any probed symbol is STALE', () => {
    const map = new Map<string, ManipulationRisk>([
      ['INFY', {
        score: 72, band: 'HIGH', freshnessStatus: 'STALE',
        latestScanAt: '2026-06-01T10:00:00.000Z', latestEventDate: '2026-05-28',
        dominantPatterns: [], alertCount: 2, criticalCount: 1,
        recommendedAction: 'WARNING_ONLY', canAffectApproval: false,
        explanation: '', evidence: [],
      }],
    ]);
    expect(buildManipulationRiskMeta(map).stale).toBe(true);
  });
});

describe('manipulationRiskMeta — API response contract', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('2.1 — zero signal rows: manipulationRiskMeta always exists on fetch result', async () => {
    const fetch = vi.fn().mockResolvedValue(mapForSymbols(UNIVERSE_25.slice(0, 20)));
    const result = await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );
    expect(result).toHaveProperty('manipulationRiskMeta');
    expect(result.manipulationRiskMeta).toBeDefined();
    expect(typeof result.manipulationRiskMeta).toBe('object');
    expect(result.manipulationRiskMeta.configured).toBe(true);
  });

  it('2.2 — scanner snapshots available: symbolCount reflects actual probed symbols', async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => `STOCK${i + 1}`);
    const fetch = vi.fn().mockResolvedValue(
      mapForSymbols(symbols, (sym) => riskWithSnapshot(`2026-06-20T10:0${sym.slice(-1)}:00.000Z`)),
    );
    const result = await fetchManipulationRiskForSignalPools(
      {
        finalRows:           symbols.map((symbol) => ({ symbol })),
        belowFloorDemoted:   [],
        inProgressEnriched:  [],
      },
      UNIVERSE_25,
      fetch,
    );
    expect(result.manipulationRiskMeta.symbolCount).toBe(10);
    expect(result.manipulationRiskMeta.snapshotCount).toBe(10);
  });

  it('2.3 — fresh timestamp available: freshestSnapshotAt is populated', async () => {
    const fetch = vi.fn().mockResolvedValue(
      mapForSymbols(['RELIANCE', 'TCS'], () =>
        riskWithSnapshot('2026-06-22T15:30:00.000Z', 'FRESH')),
    );
    const result = await fetchManipulationRiskForSignalPools(
      {
        finalRows:           [{ symbol: 'RELIANCE' }, { symbol: 'TCS' }],
        belowFloorDemoted:   [],
        inProgressEnriched:  [],
      },
      UNIVERSE_25,
      fetch,
    );
    expect(result.manipulationRiskMeta.freshestSnapshotAt).toBe('2026-06-22T15:30:00.000Z');
    expect(result.manipulationRiskMeta.stale).toBe(false);
  });

  it('2.4 — no snapshots available: metadata still returned (not omitted)', async () => {
    const fetch = vi.fn().mockResolvedValue(mapForSymbols(UNIVERSE_25.slice(0, 20)));
    const result = await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );
    expect(result.manipulationRiskMeta).toEqual({
      configured:         true,
      symbolCount:        20,
      snapshotCount:      0,
      freshestSnapshotAt: null,
      stale:              false,
      globalSnapshotCount: 0,
      globalLatestScanAt:  null,
    });
  });

  it('2.4 — fetch failure: metadata still returned with configured=false', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('scanner down'));
    const result = await fetchManipulationRiskForSignalPools(
      { finalRows: [], belowFloorDemoted: [], inProgressEnriched: [] },
      UNIVERSE_25,
      fetch,
    );
    expect(result.manipulationRiskMeta).toEqual({
      configured:         false,
      symbolCount:        0,
      snapshotCount:      0,
      freshestSnapshotAt: null,
      stale:              false,
      globalSnapshotCount: 0,
      globalLatestScanAt:  null,
    });
  });
});
