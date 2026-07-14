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
//    • kite + yahoo/nse soft placeholders (providerHealth.ts)
//    • candle freshness        (latest candle ts → quality band)
//    • market state            (marketHours.getMarketStatus)
//
//  Pure read — no DB writes, no scoring runs. Safe to poll at 10–60s
//  cadence from a dashboard.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';

import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
import { isExpectedDailySessionGap } from '@/lib/signals/engineHealthMap';
import { db } from '@/lib/db';
import { getCompositeProviderHealth } from '@/lib/monitor/providerHealth';

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
  const report = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      marketOpen,
    candle_source:    'daily',
  });
  return {
    latest_candle_iso:  latestMs != null ? new Date(latestMs).toISOString() : null,
    candle_age_seconds: report.candle_age_seconds,
    freshness_quality:  report.freshness_quality,
    feed_frozen:        report.feed_frozen && !isExpectedDailySessionGap({
      freshnessMode:    report.freshness_mode,
      staleMinutes:     report.candle_age_seconds != null
        ? Math.round(report.candle_age_seconds / 60)
        : null,
      feedFrozen:       report.feed_frozen,
      freshnessQuality: report.freshness_quality,
      feedStaleHigh:    report.feed_frozen,
    }),
  };
}

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  const market = getMarketStatus();
  const [snapshot, candle] = await Promise.all([
    Promise.resolve(getInstitutionalHealthSnapshot()),
    probeCandleFreshness(market.isOpen),
  ]);
  const composite = getCompositeProviderHealth();

  // Flag: is the pipeline broadly healthy?
  // Definition (any failing condition flips healthy=false):
  //   - candle feed frozen
  //   - Kite primary + auth failed / rate limited without fallback health
  //   - last full scan failed AND no successful run since
  //   - approved_ratio < 0.001 over a >100-row sample
  const fallbackHealthy = snapshot.providers.some((p) => p.fallback_success > 0)
    || snapshot.providers.every((p) => !p.fallback_triggered);
  const kitePrimaryBroken =
    composite.current_provider === 'kite'
    && composite.kite.configured
    && !composite.kite.available
    && !fallbackHealthy;
  const lastScanOk =
    snapshot.full_scan.completes > 0
    && (snapshot.full_scan.last_completed_at != null);
  const totalApproved = snapshot.elite.approved_total + snapshot.elite.rejected_total;
  const approvedRatioBad =
    totalApproved >= 100 && (snapshot.approved_ratio ?? 0) < 0.001;

  const healthy =
    !candle.feed_frozen
    && !kitePrimaryBroken
    && !approvedRatioBad
    && (lastScanOk || snapshot.full_scan.starts === 0);

  const stale_blocked = snapshot.elite.stale_blocked_total;
  const invalid_payload_count = snapshot.providers.reduce((s, p) => s + p.invalid_payload, 0);
  const fallback_activation_count = snapshot.providers.reduce((s, p) => s + p.fallback_triggered, 0);

  return NextResponse.json({
    response_generated_at: new Date(startedAt).toISOString(),
    healthy,
    current_provider: composite.current_provider,
    fallback_provider: composite.fallback_provider,
    market: {
      is_open:    market.isOpen,
      state:      market.state,
      label:      market.label ?? null,
    },
    provider: {
      kite: {
        ...composite.kite,
      },
      yahoo:              composite.yahoo,
      nse:                composite.nse,
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
