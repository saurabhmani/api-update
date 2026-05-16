// ════════════════════════════════════════════════════════════════
//  GET /api/system/institutional-health
//
//  Single JSON snapshot of "is the institutional pipeline healthy".
//  SRE / dashboard / alerting consume this without parsing logs.
//
//  Combines:
//    • provider counters       (institutionalHealth.ts)
//    • elite gate counters     (institutionalHealth.ts)
//    • full-scan counters      (institutionalHealth.ts)
//    • heartbeat counters      (institutionalHealth.ts)
//    • IndianAPI breaker state (IndianAPIAdapter.indianApiBreakerState)
//    • IndianAPI queue gauge   (IndianAPIAdapter.indianApiQueueGauge)
//    • candle freshness        (latest candle ts → quality band)
//    • market state            (marketHours.getMarketStatus)
//
//  Pure read — no DB writes, no scoring runs. Safe to poll at 10–60s
//  cadence from a dashboard.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';

import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import {
  indianApiBreakerState,
  indianApiQueueGauge,
} from '@/providers/adapters/IndianAPIAdapter';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

interface CandleFreshnessBlock {
  latest_candle_iso:  string | null;
  candle_age_seconds: number | null;
  freshness_quality:  string;
  feed_frozen:        boolean;
}

async function probeCandleFreshness(marketOpen: boolean): Promise<CandleFreshnessBlock> {
  let latestMs: number | null = null;
  try {
    const r = await db.query(
      `SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`,
    );
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts != null) {
      const n = Number(ts);
      if (Number.isFinite(n)) latestMs = n * 1000;
    }
  } catch {
    /* table missing in fresh DB — return unknown */
  }
  const report = classifyCandleFreshness({ latest_candle_ms: latestMs, market_open: marketOpen });
  return {
    latest_candle_iso:  latestMs != null ? new Date(latestMs).toISOString() : null,
    candle_age_seconds: report.candle_age_seconds,
    freshness_quality:  report.freshness_quality,
    feed_frozen:        report.feed_frozen,
  };
}

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  // Market state — drives the candle freshness band thresholds.
  const market = getMarketStatus();
  // Pull every counter / probe in parallel where possible. The DB
  // probe + breaker + queue gauges are cheap individually; combining
  // them in one response saves three round-trips for SRE pollers.
  const [snapshot, breaker, queue, candle] = await Promise.all([
    Promise.resolve(getInstitutionalHealthSnapshot()),
    Promise.resolve(safeProbe(() => indianApiBreakerState(), null)),
    Promise.resolve(safeProbe(() => indianApiQueueGauge(),    null)),
    probeCandleFreshness(market.isOpen),
  ]);

  // Flag: is the pipeline broadly healthy?
  // Definition (any failing condition flips healthy=false):
  //   - candle feed frozen
  //   - IndianAPI breaker open AND no recent fallback success
  //   - last full scan failed AND no successful run since
  //   - approved_ratio < 0.001 over a >100-row sample (engine
  //     producing nothing despite running)
  const fallbackHealthy = snapshot.providers.some((p) => p.fallback_success > 0)
    || snapshot.providers.every((p) => !p.fallback_triggered);
  const breakerOpen = breaker?.open === true;
  const lastScanOk =
    snapshot.full_scan.completes > 0
    && (snapshot.full_scan.last_completed_at != null);
  const totalApproved = snapshot.elite.approved_total + snapshot.elite.rejected_total;
  const approvedRatioBad =
    totalApproved >= 100 && (snapshot.approved_ratio ?? 0) < 0.001;

  const healthy =
    !candle.feed_frozen
    && !(breakerOpen && !fallbackHealthy)
    && !approvedRatioBad
    && (lastScanOk || snapshot.full_scan.starts === 0);

  // Derived: "stale rows blocked since boot" = the count of rows the
  // elite gate dropped because they were stale or expired. Already
  // tracked by recordEliteGateRun's `stale_blocked_total`.
  const stale_blocked = snapshot.elite.stale_blocked_total;
  // Derived: "invalid payload count" = sum across all providers.
  const invalid_payload_count = snapshot.providers.reduce((s, p) => s + p.invalid_payload, 0);
  // Derived: "fallback activation count" = sum of fallback_triggered.
  const fallback_activation_count = snapshot.providers.reduce((s, p) => s + p.fallback_triggered, 0);

  return NextResponse.json({
    response_generated_at: new Date(startedAt).toISOString(),
    healthy,
    market: {
      is_open:    market.isOpen,
      state:      market.state,
      label:      market.label ?? null,
    },
    provider: {
      indian_api: {
        breaker:          breaker ?? null,
        queue:            queue ?? null,
      },
      counters:           snapshot.providers,
      invalid_payload_count,
      fallback_activation_count,
    },
    candle:               candle,
    full_scan: {
      ...snapshot.full_scan,
      latest_completed_at: snapshot.full_scan.last_completed_at,
      latest_started_at:   snapshot.full_scan.last_started_at,
    },
    heartbeat:            snapshot.heartbeat,
    elite: {
      approved_total:      snapshot.elite.approved_total,
      rejected_total:      snapshot.elite.rejected_total,
      stale_blocked_total: stale_blocked,
      decay_applied_total: snapshot.elite.decay_applied_total,
      last_run_at:         snapshot.elite.last_run_at,
      last_approved:       snapshot.elite.last_approved,
      last_rejected:       snapshot.elite.last_rejected,
      last_market_open:    snapshot.elite.last_market_open,
      approved_ratio:      snapshot.approved_ratio,
    },
    process: {
      booted_at:  snapshot.booted_at,
      uptime_s:   snapshot.uptime_s,
    },
  });
}

/** Wraps a synchronous probe so a thrown error becomes the fallback
 *  value instead of poisoning the whole response. */
function safeProbe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
