// ════════════════════════════════════════════════════════════════
//  GET /api/signals/freshness
//
//  Lightweight endpoint that returns ONLY the freshness probe (latest
//  batch_id, last pipeline run timestamp, candle latest, total stored
//  signal count). No signal-row fetch, no Yahoo enrichment, no
//  applyLiveSanity — just the two small DB queries needed to answer
//  "has the pipeline finished writing?".
//
//  Why this exists:
//    The Run-Pipeline polling loop in /signals used to call
//      /api/signals?action=top&limit=1&noCache=true
//    to detect completion. Even with limit=1, action=top runs the full
//    pipeline including enrichWithLiveLtp() which has a 5-second
//    Yahoo timeout. That made the probe take 1-5 seconds → the auto-
//    stop budget ballooned to 6+ seconds despite a 1-second poll
//    interval.
//
//  This route bypasses all of that. Two DB queries (~10ms each with
//  indexes), returns immediately. Polling auto-stop now lands within
//  the requested 3-second budget.
//
//  Always uncached — by design. If callers want a cached version they
//  can hit /api/signals?action=top which has the SWR layer.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface FreshnessResponse {
  freshness: {
    server_now:               string;
    /** ISO timestamp of the most recent confirmed snapshot. */
    latest_confirmed_at:      string | null;
    latest_confirmed_ms:      number | null;
    /** Active confirmed snapshots (status='ACTIVE' AND valid_until>NOW()). */
    active_confirmed_count:   number;
    /** Latest q365_signals scanner batch — informational only. */
    latest_batch_id:          string | null;
    /** Legacy alias of latest_confirmed_at for back-compat. */
    last_pipeline_run:        string | null;
    last_pipeline_run_ms:     number | null;
    total_stored_signals:     number | null;
    candle_latest_ts:         string | null;
    /** Maturity-layer tracker counts by stage. Non-zero values prove
     *  the maturity engine is alive even when confirmed snapshots
     *  are empty (signals seasoning toward the promotion bar). */
    tracker_counts: {
      candidate:  number;
      developing: number;
      mature:     number;
      promoted:   number;
      terminated: number;
      total:      number;
    };
  };
}

async function safeQuery<T = any>(sql: string): Promise<{ rows: T[] } | null> {
  try {
    return await db.query<T>(sql);
  } catch (err) {
    console.warn('[freshness] query failed:', (err as any)?.message);
    return null;
  }
}

export async function GET(): Promise<Response> {
  const serverNow = Date.now();

  // Source of truth for the dashboard freshness banner: the confirmed
  // snapshot table. Layer-1 batch info (q365_signals.batch_id) is still
  // exposed for callers that want to verify the live scanner ran, but
  // it is no longer the authoritative "is the dashboard fresh" signal.
  const [confirmedRes, scannerRes, candleRes, trackerRes] = await Promise.all([
    safeQuery(`
      SELECT
        (SELECT UNIX_TIMESTAMP(MAX(confirmed_at))
           FROM q365_confirmed_signal_snapshots) AS latest_confirmed_ts,
        (SELECT COUNT(*) FROM q365_confirmed_signal_snapshots
          WHERE status = 'ACTIVE' AND valid_until > NOW()) AS active_count
    `),
    safeQuery(`
      SELECT
        (SELECT batch_id FROM q365_signals
         WHERE batch_id IS NOT NULL
         ORDER BY generated_at DESC LIMIT 1)               AS latest_batch_id,
        (SELECT COUNT(*) FROM q365_signals
         WHERE status IN ('active','watchlist','flagged'))  AS total_stored
    `),
    safeQuery(`SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`),
    safeQuery(`SELECT stage, COUNT(*) AS c FROM q365_signal_maturity_tracker GROUP BY stage`),
  ]);

  const confirmedRow = (confirmedRes?.rows[0] as any) ?? {};
  const scannerRow   = (scannerRes?.rows[0]   as any) ?? {};
  const candleRow    = (candleRes?.rows[0]    as any) ?? {};

  const latestConfirmedMs = confirmedRow.latest_confirmed_ts
    ? Number(confirmedRow.latest_confirmed_ts) * 1000
    : null;
  const candleLatestMs    = candleRow.ts ? Number(candleRow.ts) * 1000 : null;

  const trackerCounts = { candidate: 0, developing: 0, mature: 0, promoted: 0, terminated: 0, total: 0 };
  if (trackerRes) {
    for (const r of (trackerRes.rows as Array<{ stage: string; c: number }>)) {
      const stage = String(r.stage).toLowerCase();
      const count = Number(r.c ?? 0);
      if (stage in trackerCounts && stage !== 'total') (trackerCounts as any)[stage] = count;
      trackerCounts.total += count;
    }
  }

  const body: FreshnessResponse = {
    freshness: {
      server_now:             new Date(serverNow).toISOString(),
      latest_confirmed_at:    latestConfirmedMs ? new Date(latestConfirmedMs).toISOString() : null,
      latest_confirmed_ms:    latestConfirmedMs,
      active_confirmed_count: Number(confirmedRow.active_count ?? 0),
      latest_batch_id:        scannerRow.latest_batch_id ?? null,
      last_pipeline_run:      latestConfirmedMs ? new Date(latestConfirmedMs).toISOString() : null,
      last_pipeline_run_ms:   latestConfirmedMs,
      total_stored_signals:   scannerRow.total_stored != null ? Number(scannerRow.total_stored) : null,
      candle_latest_ts:       candleLatestMs ? new Date(candleLatestMs).toISOString() : null,
      tracker_counts:         trackerCounts,
    },
  };

  return NextResponse.json(body, {
    headers: {
      // Always uncached — this endpoint exists specifically because the
      // /api/signals SWR layer caches stale freshness for 10s, defeating
      // poll-based completion detection.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
