// ════════════════════════════════════════════════════════════════
//  candleWarehouseProbe — cheap health probe for EOD candle coverage
//
//  Production logs (engine-health requestId=engine-health-msnc2f1g)
//  showed the previous probe taking ~10.5s:
//
//    SELECT COUNT(*), MAX(ts), COUNT(DISTINCT instrument_key)
//      FROM candles WHERE candle_type='eod' AND interval_unit='1day'
//
//  That full-table aggregate is unnecessary for health: the map only
//  needs (a) whether the warehouse has any EOD rows and (b) the
//  latest bar date for freshness. Exact row/symbol counts are
//  display-only in findings.
//
//  This probe:
//    1. Uses MAX(ts) only (index-friendly with candle_type+interval+ts)
//    2. Caches results for CANDLE_PROBE_TTL_MS (default 60s)
//    3. Coalesces in-flight callers so concurrent health polls share
//       one query instead of stampeding the pool
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { engineDebugger, getEngineDebugContext } from '@/lib/engineDebug/engineDebugger';

export interface CandleWarehouseCoverage {
  latestCandleDate: string | null;
  /** 1 when warehouse has EOD rows, else 0 — exact COUNT(*) omitted. */
  candleCount:      number;
  /** Not computed on the hot path; always 0 from the cheap probe. */
  distinctSymbols:  number;
  /** True when values came from the short-TTL cache. */
  fromCache?:       boolean;
  /** Probe wall time in ms (0 when served from cache). */
  probeMs?:         number;
}

const TTL_MS = Math.max(
  5_000,
  Number(process.env.CANDLE_WAREHOUSE_PROBE_TTL_MS) || 60_000,
);

let cache: { at: number; value: CandleWarehouseCoverage } | null = null;
let inflight: Promise<CandleWarehouseCoverage> | null = null;

function toDateOnly(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.split('T')[0] ?? null;
  try {
    return new Date(raw).toISOString().split('T')[0] ?? null;
  } catch {
    return null;
  }
}

async function probeFresh(): Promise<CandleWarehouseCoverage> {
  const t0 = Date.now();
  const debugCtx = getEngineDebugContext();
  const span = debugCtx
    ? engineDebugger.dbStart({
        operation: 'candleWarehouse.maxTs',
        function: 'probeCandleWarehouse',
        engine: debugCtx.engine ?? 'data_feed',
        requestId: debugCtx.requestId,
        file: 'src/lib/monitor/candleWarehouseProbe.ts',
        meta: { table: 'candles', filter: 'eod/1day' },
      })
    : null;

  try {
    // MAX(ts) alone — avoids COUNT(*) / COUNT(DISTINCT) full scans.
    // Prefer index (candle_type, interval_unit, ts) when present.
    const { rows } = await db.query<{ latest: string | Date | null }>(
      `SELECT MAX(ts) AS latest
         FROM candles
        WHERE candle_type = 'eod'
          AND interval_unit = '1day'`,
    );
    const latestCandleDate = toDateOnly(rows?.[0]?.latest ?? null);
    const value: CandleWarehouseCoverage = {
      latestCandleDate,
      candleCount:     latestCandleDate ? 1 : 0,
      distinctSymbols: 0,
      fromCache:       false,
      probeMs:         Date.now() - t0,
    };
    span?.end('success', {
      hasData: latestCandleDate != null,
      latestCandleDate,
      probeMs: value.probeMs,
    });
    return value;
  } catch (err) {
    span?.error(err);
    return {
      latestCandleDate: null,
      candleCount: 0,
      distinctSymbols: 0,
      fromCache: false,
      probeMs: Date.now() - t0,
    };
  }
}

/**
 * Health-oriented candle warehouse probe. Never throws.
 * Shares in-flight work and caches for TTL_MS.
 */
export async function probeCandleWarehouse(): Promise<CandleWarehouseCoverage> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return { ...cache.value, fromCache: true, probeMs: 0 };
  }
  if (!inflight) {
    inflight = probeFresh()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test helper — clear TTL cache / inflight. */
export function resetCandleWarehouseProbeCache(): void {
  cache = null;
  inflight = null;
}

export const CANDLE_WAREHOUSE_PROBE_TTL_MS = TTL_MS;
