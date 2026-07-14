// Platform Reliability — evaluate rules, persist, and deliver alerts

import { evaluateAlerts, summariseAlerts, type Alert } from '@/lib/monitor/alertRules';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
import { getLiveFeedState } from '@/lib/marketData/liveFeedState';
import { isInFlight, getInFlightElapsedMs } from '@/lib/scanner/scannerState';
import { publishAlert } from '@/services/alertService';
import { db } from '@/lib/db';
import { deliverAlert } from './alertDelivery';
import { writeReliabilityAudit } from './repository/reliabilityRepository';

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

async function probeConfirmedSnapshots(): Promise<{
  active_confirmed_count: number | null;
  last_pipeline_run_ms:   number | null;
}> {
  try {
    const r = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM q365_confirmed_signal_snapshots
          WHERE status = 'ACTIVE' AND valid_until > NOW())        AS active_count,
        (SELECT UNIX_TIMESTAMP(MAX(confirmed_at))
           FROM q365_confirmed_signal_snapshots)                  AS latest_confirmed_ts
    `);
    const row = (r.rows[0] as { active_count?: number | string | null; latest_confirmed_ts?: number | string | null }) ?? {};
    const lastTs = Number(row.latest_confirmed_ts);
    return {
      active_confirmed_count: row.active_count != null ? Number(row.active_count) : null,
      last_pipeline_run_ms:   Number.isFinite(lastTs) && lastTs > 0 ? lastTs * 1000 : null,
    };
  } catch {
    return { active_confirmed_count: null, last_pipeline_run_ms: null };
  }
}

export async function evaluateProductionAlerts(): Promise<{
  alerts: Alert[];
  summary: ReturnType<typeof summariseAlerts>;
}> {
  const market = getMarketStatus();
  const snapshot = getInstitutionalHealthSnapshot();
  const latestMs = await probeLatestCandleMs();
  const candleReport = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open: market.isOpen,
  });

  const breaker: { open: boolean; state: string; auth_failed: boolean } | null = null;

  // PRODUCTION-READINESS 2026-07 — signals-pipeline probes for the
  // four minimum alerts (no confirmed signals, stale live feed,
  // stuck in-flight, quota near limit). Each probe degrades to null
  // rather than failing the whole evaluation.
  const confirmed = await probeConfirmedSnapshots();

  let liveFeed: { quality: string; market_open: boolean; approvals_blocked: boolean; tick_age_ms: number | null } | null = null;
  try {
    const feed = getLiveFeedState();
    liveFeed = {
      quality:           feed.quality,
      market_open:       feed.marketOpen,
      approvals_blocked: feed.approvalsBlocked,
      tick_age_ms:       feed.lastTickAgeMs,
    };
  } catch { /* optional */ }

  let scanner: { in_flight: boolean; elapsed_ms: number | null } | null = null;
  try {
    scanner = { in_flight: isInFlight(), elapsed_ms: getInFlightElapsedMs() };
  } catch { /* optional */ }

  const quota: { daily_percent: number; monthly_percent: number; state: string } | null = null;

  const alerts = evaluateAlerts({
    snapshot,
    candle: {
      candle_age_seconds: candleReport.candle_age_seconds,
      freshness_quality: candleReport.freshness_quality,
      feed_frozen: candleReport.feed_frozen,
      market_open: candleReport.market_open,
    },
    breaker,
    signalsPipeline: {
      market_open:            market.isOpen,
      active_confirmed_count: confirmed.active_confirmed_count,
      last_pipeline_run_ms:   confirmed.last_pipeline_run_ms,
    },
    liveFeed,
    scanner,
    quota,
  });

  return { alerts, summary: summariseAlerts(alerts) };
}

export async function dispatchAlerts(actorId?: number, actorEmail?: string): Promise<{
  evaluated: number;
  dispatched: number;
  deliveries: Array<{ alertId: string; channel: string; status: string }>;
}> {
  const { alerts, summary } = await evaluateProductionAlerts();
  const deliveries: Array<{ alertId: string; channel: string; status: string }> = [];

  // Only dispatch warning+ by default; info stays in-dashboard only
  const toDispatch = alerts.filter((a) => a.severity === 'critical' || a.severity === 'warning');

  for (const alert of toDispatch) {
    await publishAlert({
      category: 'reliability.monitor',
      severity: alert.severity,
      message: `${alert.title}: ${alert.detail}`,
      source: 'reliabilityDispatcher',
      dedupKey: alert.id,
      payload: alert.context,
    });

    const results = await deliverAlert({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      context: alert.context,
    });

    for (const r of results) {
      deliveries.push({ alertId: alert.id, channel: r.channel, status: r.status });
    }
  }

  await writeReliabilityAudit({
    actorId,
    actorEmail,
    action: 'alerts.dispatch',
    resource: 'reliability',
    detail: {
      evaluated: alerts.length,
      dispatched: toDispatch.length,
      summary,
    },
  });

  return { evaluated: alerts.length, dispatched: toDispatch.length, deliveries };
}
