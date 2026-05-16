// ════════════════════════════════════════════════════════════════
//  GET /api/metrics
//
//  Prometheus exposition endpoint. Renders this process's counters
//  in v0.0.4 text format. Each replica's metrics are labelled by
//  `instance` so a Prometheus scrape across multiple replicas
//  aggregates cleanly via PromQL `sum by(provider) (...)`.
//
//  Side-effect: every successful scrape also flushes the snapshot
//  to Redis (via flushHealthToRedis) so a non-Prometheus reader
//  (the institutional-health endpoint, an ad-hoc audit) can
//  aggregate via getAggregatedHealth(). Best-effort; a Redis
//  outage does not affect the response.
//
//  Content-Type: text/plain; version=0.0.4; charset=utf-8
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';

import {
  getInstitutionalHealthSnapshot,
} from '@/lib/monitor/institutionalHealth';
import { renderPrometheusMetrics } from '@/lib/monitor/prometheus';
import { flushHealthToRedis } from '@/lib/monitor/redisCounters';
import {
  indianApiBreakerState,
  indianApiQueueGauge,
} from '@/providers/adapters/IndianAPIAdapter';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

async function probeLatestCandleMs(): Promise<number | null> {
  try {
    const r = await db.query(`SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`);
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts == null) return null;
    const n = Number(ts);
    return Number.isFinite(n) ? n * 1000 : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const market = getMarketStatus();
  const [snapshot, breaker, queue, latestMs] = await Promise.all([
    Promise.resolve(getInstitutionalHealthSnapshot()),
    Promise.resolve(safe(() => indianApiBreakerState(), null)),
    Promise.resolve(safe(() => indianApiQueueGauge(), null)),
    probeLatestCandleMs(),
  ]);
  const candleReport = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      market.isOpen,
  });

  const body = renderPrometheusMetrics({
    snapshot,
    candle: {
      candle_age_seconds: candleReport.candle_age_seconds,
      freshness_quality:  candleReport.freshness_quality,
      feed_frozen:        candleReport.feed_frozen,
      market_open:        candleReport.market_open,
    },
    breaker: breaker
      ? {
          state:       breaker.state,
          open:        breaker.open,
          remainingMs: breaker.remainingMs,
          auth_failed: breaker.auth_failed,
        }
      : null,
    queue:   queue ?? null,
  });

  // Best-effort Redis mirror — fire-and-forget so a Redis stall does
  // not delay the scrape response. Prometheus scrapes are typically
  // every 15s so the flush cadence aligns naturally.
  void flushHealthToRedis().catch(() => undefined);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type':  'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function safe<T>(fn: () => T, fb: T): T {
  try { return fn(); } catch { return fb; }
}
