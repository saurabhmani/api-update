// Platform Reliability — evaluate rules, persist, and deliver alerts

import { evaluateAlerts, summariseAlerts, type Alert } from '@/lib/monitor/alertRules';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { indianApiBreakerState } from '@/providers/adapters/IndianAPIAdapter';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
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

  let breaker: { open: boolean; state: string; auth_failed: boolean } | null = null;
  try {
    const b = indianApiBreakerState();
    breaker = { open: b.open, state: b.state, auth_failed: b.auth_failed };
  } catch { /* optional */ }

  const alerts = evaluateAlerts({
    snapshot,
    candle: {
      candle_age_seconds: candleReport.candle_age_seconds,
      freshness_quality: candleReport.freshness_quality,
      feed_frozen: candleReport.feed_frozen,
      market_open: candleReport.market_open,
    },
    breaker,
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
