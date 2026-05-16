// ════════════════════════════════════════════════════════════════
//  GET /api/system/alerts
//
//  Production alerting endpoint. Evaluates the alertRules rule set
//  against the current institutional-health snapshot + auxiliary
//  probes (candle freshness, IndianAPI breaker) and returns the
//  triggered alerts.
//
//  Output shape:
//    {
//      response_generated_at: ISO,
//      worst_severity: 'critical' | 'warning' | 'info' | null,
//      summary: { critical, warning, info, total },
//      alerts:  [...],
//    }
//
//  Designed for periodic polling by Slack / PagerDuty integrations
//  (60s cadence works). The alert set is computed fresh every request
//  — there's no in-process queue to drain.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';

import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { evaluateAlerts, summariseAlerts } from '@/lib/monitor/alertRules';
import { indianApiBreakerState } from '@/providers/adapters/IndianAPIAdapter';
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

export async function GET(): Promise<NextResponse> {
  const startedAt = new Date().toISOString();
  const market = getMarketStatus();
  const [snapshot, latestMs] = await Promise.all([
    Promise.resolve(getInstitutionalHealthSnapshot()),
    probeLatestCandleMs(),
  ]);
  const candleReport = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      market.isOpen,
  });
  const breaker = safe(() => indianApiBreakerState(), null);

  const alerts = evaluateAlerts({
    snapshot,
    candle: {
      candle_age_seconds: candleReport.candle_age_seconds,
      freshness_quality:  candleReport.freshness_quality,
      feed_frozen:        candleReport.feed_frozen,
      market_open:        candleReport.market_open,
    },
    breaker: breaker
      ? { open: breaker.open, state: breaker.state, auth_failed: breaker.auth_failed }
      : null,
  });
  const summary = summariseAlerts(alerts);

  return NextResponse.json({
    response_generated_at: startedAt,
    worst_severity:        summary.worst_severity,
    summary: {
      critical: summary.critical,
      warning:  summary.warning,
      info:     summary.info,
      total:    summary.total,
    },
    alerts,
  });
}

function safe<T>(fn: () => T, fb: T): T {
  try { return fn(); } catch { return fb; }
}
