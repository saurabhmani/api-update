// ════════════════════════════════════════════════════════════════
//  GET /api/data-feed/health  — Step 7 of the IndianAPI cutover.
//
//  Returns the dashboard's "Data Source / Last API Request / Last
//  Success / Coverage / Freshness / Fallback Used" panel state.
//
//  Two layers:
//    • In-memory ring buffer (last ~250 invocations) — instant read,
//      no DB roundtrip. Used for the live status fields.
//    • q365_data_feed_health DB table — long history, indexed by
//      (provider, request_started_at). Queried only when the caller
//      asks for ?history=N.
//
//  This endpoint never throws and never hits the upstream provider.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getFeedHealthRing,
  getLastRequestRow,
  getLastSuccessRow,
} from '@/lib/marketData/feedHealthLog';
import { getMarketDataHealth } from '@/lib/marketData/marketDataHealth';
import { getProviderFlagsSummary } from '@/lib/marketData/providerFlags';
import { getManualRunStatus } from '@/lib/pipeline/runLockRepo';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Freshness = 'Fresh' | 'Stale' | 'Degraded' | 'Offline';

function freshnessFromAgeMs(ageMs: number | null, latestQuality: string | null): Freshness {
  if (ageMs == null) return 'Offline';
  if (ageMs < 60_000   && latestQuality === 'HIGH')   return 'Fresh';
  if (ageMs < 300_000  && latestQuality !== 'LOW')    return 'Fresh';
  if (ageMs < 900_000)                                 return 'Stale';
  if (ageMs < 3 * 3_600_000)                           return 'Degraded';
  return 'Offline';
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const wantHistory = Number(url.searchParams.get('history') ?? 0);

  const lastReq = getLastRequestRow();
  const lastSuc = getLastSuccessRow();
  const now = Date.now();
  const ageSinceLastSuccessMs = lastSuc
    ? Math.max(0, now - new Date(lastSuc.response_received_at).getTime())
    : null;

  const flags = getProviderFlagsSummary();
  const coarse = getMarketDataHealth();

  // Determine the active provider label. The flag wins when present;
  // when no requests have run yet (cold boot) we fall back to flags.
  const dataSource =
    lastReq?.provider === 'indianapi' ? 'IndianAPI' :
    lastReq?.provider === 'cache'     ? 'Cache' :
    lastReq?.provider === 'nse_direct' ? 'NSE Direct' :
    lastReq?.provider === 'yahoo'     ? 'Yahoo (Emergency)' : // @deprecated marker
    flags.marketDataProvider === 'indianapi' ? 'IndianAPI' : String(flags.marketDataProvider);

  const fallbackUsed =
    lastReq?.provider === 'nse_direct' ? 'NSE Direct' :
    lastReq?.provider === 'yahoo'     ? 'Emergency Yahoo' : // @deprecated marker
    'No';

  // Coverage / freshness — computed from the most recent successful
  // batch. If the last invocation was a single-symbol call we surface
  // its coverage but mark the freshness from its quality field.
  const coverage = lastSuc?.coverage_percent ?? 0;
  let freshness = freshnessFromAgeMs(ageSinceLastSuccessMs, lastSuc?.data_quality ?? null);

  // Market-closed mode: the resolver gate correctly suppresses upstream
  // calls outside session hours, so `lastSuccessAt` ages indefinitely
  // and `freshnessFromAgeMs` lands on 'Offline'. That paints a red
  // OFFLINE banner on a system that is actually healthy and serving
  // last-close snapshot data on purpose. When the coarse health says
  // DEGRADED *because* the market is closed (not because something is
  // broken), downgrade the banner from 'Offline' → 'Stale' (yellow,
  // "static data acceptable") to match the real system state.
  if (!coarse.market.isOpen
      && coarse.health === 'DEGRADED'
      && coarse.source === 'indianapi'
      && (freshness === 'Offline' || freshness === 'Degraded')) {
    freshness = 'Stale';
  }

  // Manual run last timestamp — the dashboard renders these next to
  // "Last Pipeline Run" so the operator sees the manual-vs-cron split.
  const manual = await getManualRunStatus().catch(() => null);

  // Last confirmed-signal write — the dashboard's "Last Confirmed
  // Signal Update" field reads this. We pick MAX(updated_at) over
  // active rows because the lifecycle worker bumps updated_at on
  // status transitions (TARGET_HIT / STOP_LOSS_HIT / EXPIRED /
  // INVALIDATED) and the maturity worker bumps it on insertion.
  let lastConfirmedSignalUpdateAt: string | null = null;
  try {
    const { rows: cs } = await db.query<{ latest: Date | string | null }>(
      `SELECT MAX(updated_at) AS latest FROM q365_confirmed_signal_snapshots`,
    );
    const v = (cs as any[])[0]?.latest;
    if (v) {
      lastConfirmedSignalUpdateAt =
        v instanceof Date ? v.toISOString() : new Date(v).toISOString();
    }
  } catch {
    // Table may not exist yet on a fresh DB; leave null.
  }

  const summary = {
    dataSource,
    lastApiRequestAt:            lastReq?.request_started_at   ?? null,
    lastApiResponseAt:           lastReq?.response_received_at ?? null,
    lastSuccessAt:               lastSuc?.response_received_at ?? null,
    lastPipelineRunAt:           manual?.lastRunAt ?? null,
    lastConfirmedSignalUpdateAt,
    coveragePercent:             coverage,
    freshness,
    fallbackUsed,
    providerFlags:               flags,
    coarseHealth:                coarse,
    lastRequest:                 lastReq,
    lastSuccess:                 lastSuc,
  };

  if (wantHistory <= 0) {
    return NextResponse.json({
      ...summary,
      ring: getFeedHealthRing(50),
    });
  }

  // History: pull from the persistent table when asked.
  let history: unknown[] = [];
  try {
    const limit = Math.min(Math.max(1, wantHistory), 1000);
    const { rows } = await db.query(
      `SELECT provider, endpoint, request_started_at, response_received_at,
              status, latency_ms, symbols_requested, symbols_returned,
              coverage_percent, data_quality, error_code, error_message
         FROM q365_data_feed_health
         ORDER BY id DESC
         LIMIT ?`,
      [limit],
    );
    history = rows;
  } catch (err) {
    history = [];
    console.warn('[/api/data-feed/health] history query failed (non-fatal):',
      err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json({
    ...summary,
    ring: getFeedHealthRing(50),
    history,
  });
}
