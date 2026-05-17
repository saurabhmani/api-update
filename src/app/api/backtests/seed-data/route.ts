// ════════════════════════════════════════════════════════════════
//  /api/backtests/seed-data
//
//  GET  — Fast availability check against the EOD `candles` table
//         that the NSE ingestion pipeline populates. Never times out:
//         a single aggregated query, no per-symbol loop.
//
//  POST — Deprecated. The legacy synchronous Yahoo seeder used to hang
//         long enough to hit the 60s Nginx gateway timeout (504). The
//         new flow is the NSE EOD ingestion pipeline at
//         POST /api/manipulation/eod-ingest, which is the authoritative
//         source for the `candles` warehouse the backtester reads.
//
//         This route now always returns JSON immediately:
//           { ok: false, deprecated: true, message: "...", redirectTo: "..." }
//         status=410 (Gone). Nothing is fetched, nothing is persisted.
//
//  Every response is application/json — no HTML error pages, even on
//  unexpected failure, so the UI's readJsonOrThrow() helper never sees
//  an opaque 504 from the proxy.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MIN_CANDLES_PER_SYMBOL = 200;

/** GET — availability check against existing EOD candles. */
export async function GET() {
  const ROUTE = '/api/backtests/seed-data';
  try {
    const universe = DEFAULT_BACKTEST_CONFIG.universe ?? [];
    const totalSymbols = universe.length;

    // Single aggregated query — counts distinct instrument_keys that
    // already have enough EOD candles to be backtestable. This replaces
    // the old N+1 LIKE loop that ran one query per universe symbol and
    // could exceed the proxy timeout on a 500-symbol universe.
    const { rows: readyRows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT instrument_key
           FROM candles
          WHERE candle_type='eod' AND interval_unit='1day'
          GROUP BY instrument_key
         HAVING COUNT(*) >= ?
       ) t`,
      [MIN_CANDLES_PER_SYMBOL],
    );
    const readyKeys = Number(readyRows?.[0]?.cnt ?? 0);

    const { rows: totalRows } = await db.query<{ cnt: number; latest: string | Date | null }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest
         FROM candles
        WHERE candle_type='eod' AND interval_unit='1day'`,
    );
    const totalCandles = Number(totalRows?.[0]?.cnt ?? 0);
    const rawLatest = totalRows?.[0]?.latest ?? null;
    const latestCandleDate =
      rawLatest == null
        ? null
        : typeof rawLatest === 'string'
          ? rawLatest.split('T')[0]
          : new Date(rawLatest).toISOString().split('T')[0];

    // readySymbols is capped at universe length so the UI banner
    // (ready/total) makes sense even when the warehouse holds many
    // extra symbols outside the active universe.
    const readySymbols = totalSymbols > 0 ? Math.min(readyKeys, totalSymbols) : readyKeys;
    const needsSeeding = totalSymbols > 0 ? readySymbols < totalSymbols : totalCandles === 0;

    return NextResponse.json({
      ok: true,
      source: 'nse_eod_pipeline',
      totalSymbols,
      readySymbols,
      readyKeysAcrossWarehouse: readyKeys,
      totalCandles,
      minCandlesPerSymbol: MIN_CANDLES_PER_SYMBOL,
      latestCandleDate,
      needsSeeding,
      message:
        totalCandles === 0
          ? 'No EOD candles in warehouse. Run EOD ingestion to populate (POST /api/manipulation/eod-ingest).'
          : needsSeeding
            ? `Only ${readySymbols}/${totalSymbols} symbols have ≥${MIN_CANDLES_PER_SYMBOL} EOD candles. Run EOD ingestion to backfill.`
            : 'EOD candle warehouse is ready for backtesting.',
    });
  } catch (err) {
    console.error('[Backtesting API] seed-data GET failed', {
      route: ROUTE,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to check data',
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

/**
 * POST — deprecated. Returns immediately with a JSON pointer to the
 * NSE EOD ingestion pipeline. Never runs the legacy Yahoo seeder, so
 * the request can never exceed the Nginx gateway timeout.
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      ok: false,
      deprecated: true,
      message:
        'Legacy seed-data route is deprecated. Use the NSE EOD ingestion pipeline ' +
        'to populate the candles warehouse that the backtester reads from.',
      redirectTo: '/api/manipulation/eod-ingest',
      hint:
        'POST /api/manipulation/eod-ingest with {} to ingest the most recent NSE trading day, ' +
        'or run it on a schedule. Backtesting reads directly from the resulting `candles` rows.',
      generatedAt: new Date().toISOString(),
    },
    { status: 410 },
  );
}
