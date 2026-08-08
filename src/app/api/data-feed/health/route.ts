// ════════════════════════════════════════════════════════════════
//  GET /api/data-feed/health  — Step 7 of the removed vendor cutover.
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
  getLastRequestRowPersistent,
  getLastSuccessRowPersistent,
} from '@/lib/marketData/feedHealthLog';
import { getMarketDataHealth } from '@/lib/marketData/marketDataHealth';
import { getProviderFlagsSummary, isDualSourceEnabled } from '@/lib/marketData/providerFlags';
import { getLiveFeedState, getLiveFeedStateFor } from '@/lib/marketData/liveFeedState';
import {
  getLatestPipelineRunAt,
  getManualRunStatus,
} from '@/lib/pipeline/runLockRepo';
import { getSession } from '@/lib/session';
import { getUserActiveDataSource } from '@/lib/broker/connections/activeDataSource';
import { getPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function labelForUserProvider(provider: string | null | undefined): string | null {
  if (provider === 'shoonya') return 'Shoonya';
  if (provider === 'zerodha') return 'Zerodha';
  return null;
}

type Freshness = 'Fresh' | 'Stale' | 'Degraded' | 'Offline' | 'Market Closed';

function freshnessFromAgeMs(
  ageMs: number | null,
  latestQuality: string | null,
  opts: {
    marketOpen: boolean;
    coarseHealth: ReturnType<typeof getMarketDataHealth>;
    lastPipelineRunAt: string | null;
  },
): Freshness {
  if (ageMs == null) {
    const coarse = opts.coarseHealth;
    const tickAge = coarse.lastTickAgeMs;
    // Live WS feed is pushing — ring buffer may lag on cold boot.
    // Only treat recent ticks as "Fresh" during session hours; off-hours
    // polls (Yahoo/removed vendor background loops) must not flip the badge green.
    if (opts.marketOpen) {
      if (tickAge != null && tickAge < 120_000) return 'Fresh';
      if (coarse.subscribedCount > 0 && coarse.tickRatePerSec > 0) return 'Fresh';
      if (coarse.health === 'OK') return 'Stale';
    }
    if (!opts.marketOpen && coarse.health === 'DEGRADED') return 'Stale';
    // Signal pipeline ran recently — engine is alive even if quotes aren't logged.
    if (opts.lastPipelineRunAt) {
      const pipelineAge = Date.now() - new Date(opts.lastPipelineRunAt).getTime();
      if (Number.isFinite(pipelineAge) && pipelineAge < 2 * 3_600_000) return 'Stale';
    }
    return 'Offline';
  }
  if (ageMs < 60_000   && latestQuality === 'HIGH')   return 'Fresh';
  if (ageMs < 300_000  && latestQuality !== 'LOW')    return 'Fresh';
  if (ageMs < 900_000)                                 return 'Stale';
  if (ageMs < 3 * 3_600_000)                           return 'Degraded';
  return 'Offline';
}

function labelSystemProvider(provider: string | null | undefined): string {
  const p = String(provider ?? '').toLowerCase();
  if (p === 'indianapi' || p === 'indian_api') return 'IndianAPI';
  if (p === 'kite') return 'Kite';
  if (p === 'cache') return 'Cache';
  if (p === 'nse_direct') return 'NSE Direct';
  if (p === 'nse_bhavcopy') return 'NSE Bhavcopy';
  if (p === 'yahoo' || p === 'yahoo_emergency') return 'Yahoo';
  if (p === 'snapshot') return 'DB Snapshot';
  if (p === 'none' || !p) return 'None';
  return String(provider);
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const wantHistory = Number(url.searchParams.get('history') ?? 0);

  const [lastReq, lastSuc, manual, latestLockAt] = await Promise.all([
    getLastRequestRowPersistent(),
    getLastSuccessRowPersistent(),
    getManualRunStatus().catch(() => null),
    getLatestPipelineRunAt().catch(() => null),
  ]);
  const now = Date.now();
  const ageSinceLastSuccessMs = lastSuc
    ? Math.max(0, now - new Date(lastSuc.response_received_at).getTime())
    : null;

  const flags = getProviderFlagsSummary();
  const coarse = getMarketDataHealth();

  // Prefer the authenticated user's active data source over system
  // MARKET_DATA_PROVIDER (often still "kite" for jobs only).
  let userProviderLabel: string | null = null;
  let userFeedFresh: boolean | null = null;
  try {
    const session = await getSession();
    if (session?.id) {
      const active = await getUserActiveDataSource(Number(session.id));
      userProviderLabel = labelForUserProvider(active.provider);
      if (active.provider && active.isConnected) {
        const keyed = getLiveFeedStateFor({
          userId: String(session.id),
          provider: active.provider,
        });
        userFeedFresh =
          keyed.status === 'fresh' || keyed.status === 'delayed';
      }
    }
  } catch {
    // Unauthenticated health still works for ops panels.
  }

  // System-job / ring-buffer label — never overrides an explicit
  // user active broker on the signals UI.
  const configuredProvider =
    typeof flags.marketDataProvider === 'string' ? flags.marketDataProvider : null;
  const systemDataSource =
    labelSystemProvider(lastReq?.provider) !== 'None'
    && lastReq?.provider
      ? labelSystemProvider(lastReq.provider)
      : labelSystemProvider(configuredProvider);

  // Prefer configured IndianAPI warehouse label when the last logged
  // request was cache noise / unrelated and the system provider is IndianAPI.
  const dataSource = userProviderLabel
    ?? (configuredProvider === 'indianapi' ? 'IndianAPI' : systemDataSource);

  const fallbackUsed =
    lastReq?.provider === 'nse_direct' ? 'NSE Direct' :
    lastReq?.provider === 'yahoo' && !isDualSourceEnabled() ? 'Emergency Yahoo' : // @deprecated marker
    'No';

  // Prefer any recent lock / heartbeat / signal write over "today's
  // manual quota only" — scheduler runs never create a same-day manual row.
  let lastPipelineRunAt: string | null = manual?.lastRunAt ?? latestLockAt ?? null;
  try {
    const hb = await getPipelineHeartbeat();
    if (hb?.at) {
      const hbIso = new Date(hb.at).toISOString();
      if (!lastPipelineRunAt || hb.at > new Date(lastPipelineRunAt).getTime()) {
        lastPipelineRunAt = hbIso;
      }
    }
  } catch {
    /* redis optional */
  }
  if (!lastPipelineRunAt) {
    try {
      const { rows } = await db.query<{ ts: Date | string | null }>(
        `SELECT MAX(generated_at) AS ts FROM q365_signals
          WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      );
      const v = rows?.[0]?.ts;
      if (v) {
        lastPipelineRunAt = v instanceof Date
          ? v.toISOString()
          : new Date(String(v)).toISOString();
      }
    } catch {
      /* ignore */
    }
  }

  // Coverage / freshness — computed from the most recent successful
  // batch. If the last invocation was a single-symbol call we surface
  // its coverage but mark the freshness from its quality field.
  const coverage = lastSuc?.coverage_percent ?? 0;
  let freshness = freshnessFromAgeMs(ageSinceLastSuccessMs, lastSuc?.data_quality ?? null, {
    marketOpen: coarse.market.isOpen,
    coarseHealth: coarse,
    lastPipelineRunAt,
  });

  // Market-closed mode: the resolver gate correctly suppresses upstream
  // calls outside session hours, so `lastSuccessAt` ages indefinitely
  // and `freshnessFromAgeMs` can land on 'Stale' / 'Offline'. Background
  // poll loops may still run and were incorrectly keeping the badge on
  // 'Fresh' because the override below used to skip when already Fresh.
  // When the session is closed, label honestly as 'Market Closed' —
  // last-close snapshot data is expected, not live freshness.
  if (!coarse.market.isOpen) {
    freshness = 'Market Closed';
  }

  // Prefer per-user keyed freshness when the session has an active broker.
  const liveFeed = getLiveFeedState();
  if (coarse.market.isOpen) {
    if (userFeedFresh) {
      freshness = 'Fresh';
    } else if (liveFeed.quality === 'fresh' || liveFeed.quality === 'delayed') {
      freshness = 'Fresh';
    }
  }

  // "Last Confirmed Signal" must reflect when a snapshot was *confirmed*
  // (inserted/promoted), NOT the last lifecycle touch. Lifecycle expiry
  // bumps `updated_at` on EXPIRED rows — using MAX(updated_at) made the
  // UI look freshly confirmed (e.g. 6 Aug) when the real confirmation
  // was older (5 Aug) and production could still show July while local
  // showed August after an expiry pass.
  let lastConfirmedSignalUpdateAt: string | null = null;
  let lastConfirmedAt: string | null = null;
  let lastSnapshotLifecycleUpdateAt: string | null = null;
  let confirmedSnapshotCounts: {
    total: number;
    active: number;
  } | null = null;
  try {
    const { rows: cs } = await db.query<{
      max_confirmed: Date | string | null;
      max_updated: Date | string | null;
      total: number;
      active: number;
    }>(
      `SELECT
         MAX(confirmed_at) AS max_confirmed,
         MAX(updated_at) AS max_updated,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'ACTIVE' AND valid_until > NOW() THEN 1 ELSE 0 END) AS active
       FROM q365_confirmed_signal_snapshots`,
    );
    const row = (cs as any[])[0] ?? {};
    const toIso = (v: unknown): string | null => {
      if (!v) return null;
      if (v instanceof Date) return v.toISOString();
      const d = new Date(String(v));
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    };
    lastConfirmedAt = toIso(row.max_confirmed);
    lastSnapshotLifecycleUpdateAt = toIso(row.max_updated);
    // Backward-compatible field name — now semantically "last confirmation".
    lastConfirmedSignalUpdateAt = lastConfirmedAt;
    confirmedSnapshotCounts = {
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
    };
  } catch {
    // Table may not exist yet on a fresh DB; leave null.
  }

  // Safe identity (no secrets) so operators can tell localhost DB from
  // production when comparing screenshots of the same UI.
  const runtimeIdentity = {
    databaseHost: process.env.MYSQL_HOST || 'unknown',
    databaseName: process.env.MYSQL_DATABASE || 'unknown',
    nodeEnv: process.env.NODE_ENV || 'undefined',
    timezone: 'Asia/Kolkata',
    envFileHint:
      process.env.DOTENV_CONFIG_PATH ||
      (process.env.NODE_ENV === 'production' ? '.env' : '.env.local'),
  };

  // Separate freshness timestamps — never conflate with Last Confirmed.
  let tradingFreshness: Awaited<
    ReturnType<typeof import('@/lib/marketData/tradingDataFreshness').getTradingSessionFreshness>
  > | null = null;
  let maturityLastEval: string | null = null;
  try {
    const { getTradingSessionFreshness } = await import(
      '@/lib/marketData/tradingDataFreshness'
    );
    tradingFreshness = await getTradingSessionFreshness();
  } catch {
    tradingFreshness = null;
  }
  try {
    const { rows: mat } = await db.query<{ mx: Date | string | null }>(
      `SELECT MAX(last_evaluated_at) AS mx FROM q365_signal_maturity_tracker`,
    );
    const v = mat[0]?.mx;
    maturityLastEval = v ? new Date(v as Date | string).toISOString() : null;
  } catch {
    maturityLastEval = null;
  }

  // IndianAPI warehouse fallbacks when feed_health has no usable rows
  // (common: candle job writes warehouse without per-call health rows).
  let lastApiRequestAt = lastReq?.request_started_at ?? null;
  let lastApiResponseAt = lastReq?.response_received_at ?? null;
  let lastSuccessAt = lastSuc?.response_received_at ?? null;

  const maxIso = (a: string | null, b: string | null): string | null => {
    if (!a) return b;
    if (!b) return a;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  };

  if (!lastApiRequestAt || !lastSuccessAt) {
    try {
      const { rows: ing } = await db.query<{
        started_at: Date | string | null;
        finished_at: Date | string | null;
        status: string | null;
      }>(
        `SELECT started_at, finished_at, status
           FROM indianapi_ingestion_runs
          ORDER BY started_at DESC
          LIMIT 1`,
      );
      const r = ing?.[0];
      if (r?.started_at) {
        const started = r.started_at instanceof Date
          ? r.started_at.toISOString()
          : new Date(String(r.started_at)).toISOString();
        lastApiRequestAt = maxIso(lastApiRequestAt, started);
        if (r.finished_at && String(r.status ?? '').toLowerCase() === 'success') {
          const finished = r.finished_at instanceof Date
            ? r.finished_at.toISOString()
            : new Date(String(r.finished_at)).toISOString();
          lastSuccessAt = maxIso(lastSuccessAt, finished);
          lastApiResponseAt = maxIso(lastApiResponseAt, finished);
        }
      }
    } catch {
      /* optional table */
    }
  }

  if (!lastSuccessAt || !lastApiRequestAt) {
    try {
      const { rows: cnd } = await db.query<{ mx: Date | string | null }>(
        `SELECT MAX(updated_at) AS mx FROM candles
          WHERE source = 'indianapi' AND candle_type = 'eod'`,
      );
      const v = cnd?.[0]?.mx;
      if (v) {
        const iso = v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
        lastApiRequestAt = maxIso(lastApiRequestAt, iso);
        lastSuccessAt = maxIso(lastSuccessAt, iso);
        lastApiResponseAt = maxIso(lastApiResponseAt, iso);
      }
    } catch {
      /* optional */
    }
  }

  // Prefer scheduled scan / signal write when locks were never claimed.
  if (!lastPipelineRunAt && tradingFreshness?.latestScheduledScanAt) {
    lastPipelineRunAt = tradingFreshness.latestScheduledScanAt;
  }
  if (!lastPipelineRunAt && tradingFreshness?.latestSignalAt) {
    lastPipelineRunAt = tradingFreshness.latestSignalAt;
  }
  if (!lastPipelineRunAt && maturityLastEval) {
    lastPipelineRunAt = maturityLastEval;
  }

  const summary = {
    dataSource,
    userProvider:                userProviderLabel,
    systemDataSource,
    lastApiRequestAt,
    lastApiResponseAt,
    lastSuccessAt,
    lastPipelineRunAt,
    lastConfirmedSignalUpdateAt,
    lastConfirmedAt,
    lastSnapshotLifecycleUpdateAt,
    confirmedSnapshotCounts,
    runtimeIdentity,
    tradingSessionFreshness:     tradingFreshness,
    latestMaturityEvaluationAt:  maturityLastEval,
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
