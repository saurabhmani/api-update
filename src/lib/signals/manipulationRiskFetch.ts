import type { ManipulationRisk } from '@/lib/manipulation-engine/manipulationSignalRisk';
import { computeManipulationFreshness } from '@/lib/manipulation-engine/manipulationSignalRisk';

export const MANIPULATION_FALLBACK_SAMPLE_SIZE = 20;

type SymbolRow = { symbol?: string | null; tradingsymbol?: string | null };

export function resolveManipulationSymbolsToQuery(
  pools: {
    finalRows:           SymbolRow[];
    belowFloorDemoted:   SymbolRow[];
    inProgressEnriched:  SymbolRow[];
  },
  universe: readonly string[],
  sampleSize = MANIPULATION_FALLBACK_SAMPLE_SIZE,
): { symbolsToCheck: string[]; usedFallbackUniverse: boolean } {
  const signalSymbols: string[] = [];
  for (const r of [...pools.finalRows, ...pools.belowFloorDemoted, ...pools.inProgressEnriched]) {
    const s = r.symbol ?? r.tradingsymbol;
    if (s) signalSymbols.push(String(s));
  }
  const usedFallbackUniverse = signalSymbols.length === 0;
  const symbolsToCheck = usedFallbackUniverse
    ? universe.slice(0, sampleSize)
    : signalSymbols;
  return { symbolsToCheck, usedFallbackUniverse };
}

export type ManipulationRiskMeta = {
  /** True when manipulation risk fetch completed for this cycle. */
  configured:          boolean;
  /** Symbols passed to getManipulationRiskForSymbols. */
  symbolCount:           number;
  /** Symbols with a persisted snapshot (latestScanAt present). */
  snapshotCount:         number;
  /** Latest snapshot timestamp across probed symbols. */
  freshestSnapshotAt:    string | null;
  /** True when any probed symbol reports STALE freshness. */
  stale:                 boolean;
  /** Global snapshot rows in last 30d — distinguishes idle vs pool coverage gap. */
  globalSnapshotCount:   number;
  /** Latest snapshot timestamp across the full surveillance table. */
  globalLatestScanAt:    string | null;
  /** Expected completed scan session (YYYY-MM-DD) for current lifecycle point. */
  expectedSessionDate?:   string;
  /** Latest persisted snapshot session date (YYYY-MM-DD). */
  freshestSnapshotSession?: string;
  freshnessStatus?:       string;
  scanDue?:               boolean;
  lifecyclePhase?:        string;
  staleReason?:             string;
};

export type ManipulationRiskGlobalProbe = {
  globalSnapshotCount: number;
  globalLatestScanAt:  string | null;
  /** Global surveillance freshness — drives engine-health stale flag. */
  globalIsStale?:      boolean;
};

export function buildManipulationRiskMeta(
  map: ReadonlyMap<string, ManipulationRisk> | undefined,
  global: ManipulationRiskGlobalProbe = { globalSnapshotCount: 0, globalLatestScanAt: null },
): ManipulationRiskMeta {
  const empty: ManipulationRiskMeta = {
    configured:         false,
    symbolCount:        0,
    snapshotCount:      0,
    freshestSnapshotAt: null,
    stale:              false,
    globalSnapshotCount: global.globalSnapshotCount,
    globalLatestScanAt:  global.globalLatestScanAt,
  };
  if (!map || map.size === 0) return empty;

  let snapshotCount = 0;
  let freshestSnapshotAt: string | null = null;
  let anySymbolStale = false;

  for (const risk of map.values()) {
    if (risk.latestScanAt != null) {
      snapshotCount++;
      if (freshestSnapshotAt == null || risk.latestScanAt > freshestSnapshotAt) {
        freshestSnapshotAt = risk.latestScanAt;
      }
    }
    if (risk.freshnessStatus === 'STALE') {
      anySymbolStale = true;
    }
  }

  const stale = Boolean(global.globalIsStale) || anySymbolStale;

  return {
    configured:         true,
    symbolCount:        map.size,
    snapshotCount,
    freshestSnapshotAt,
    stale,
    globalSnapshotCount: global.globalSnapshotCount,
    globalLatestScanAt:  global.globalLatestScanAt,
  };
}

export type FetchManipulationRiskResult = {
  manipulationRiskMap: ReadonlyMap<string, ManipulationRisk> | undefined;
  manipulationUsedFallbackUniverse: boolean;
  manipulationRiskMeta: ManipulationRiskMeta;
};

/**
 * Resolve symbols from signal pools (or universe fallback) and fetch
 * manipulation risk. Never throws — failures degrade to undefined map.
 */
export async function fetchManipulationRiskForSignalPools(
  pools: {
    finalRows:           SymbolRow[];
    belowFloorDemoted:   SymbolRow[];
    inProgressEnriched:  SymbolRow[];
  },
  universe: readonly string[],
  fetch: (symbols: string[]) => Promise<ReadonlyMap<string, ManipulationRisk>>,
  sampleSize = MANIPULATION_FALLBACK_SAMPLE_SIZE,
): Promise<FetchManipulationRiskResult> {
  const { symbolsToCheck, usedFallbackUniverse } = resolveManipulationSymbolsToQuery(
    pools,
    universe,
    sampleSize,
  );
  const globalProbe = await computeManipulationFreshness()
    .then((f): ManipulationRiskGlobalProbe => ({
      globalSnapshotCount: f.snapshotsPersisted30d ?? 0,
      globalLatestScanAt:  f.latestScanAt,
      globalIsStale:       f.isStale,
    }))
    .catch((): ManipulationRiskGlobalProbe => ({
      globalSnapshotCount: 0,
      globalLatestScanAt:  null,
    }));

  if (symbolsToCheck.length === 0) {
    return {
      manipulationRiskMap:              undefined,
      manipulationUsedFallbackUniverse: usedFallbackUniverse,
      manipulationRiskMeta:             buildManipulationRiskMeta(undefined, globalProbe),
    };
  }
  try {
    const manipulationRiskMap = await fetch(symbolsToCheck);
    console.log(
      `[api/signals] Manipulation risk fetched for ${symbolsToCheck.length} symbols` +
      (usedFallbackUniverse ? ' (fallback universe sample)' : ''),
    );
    return {
      manipulationRiskMap,
      manipulationUsedFallbackUniverse: usedFallbackUniverse,
      manipulationRiskMeta:             buildManipulationRiskMeta(manipulationRiskMap, globalProbe),
    };
  } catch (err) {
    console.warn('[api/signals] manipulation risk fetch failed:', err);
    return {
      manipulationRiskMap:              undefined,
      manipulationUsedFallbackUniverse: usedFallbackUniverse,
      manipulationRiskMeta:             buildManipulationRiskMeta(undefined, globalProbe),
    };
  }
}
