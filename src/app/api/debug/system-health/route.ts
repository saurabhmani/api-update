// ════════════════════════════════════════════════════════════════
//  GET /api/debug/system-health
//
//  Spec API_HEALTH_MONITOR §6 — full operator view of:
//
//    • per-day API usage (IST calendar day)
//    • per-route + per-provider breakdowns
//    • avg / max latency
//    • error rate
//    • fallback events
//    • last error
//    • slow request log + recent traces
//    • market state (open / closed / weekend / holiday)
//
//  Read-only. Never calls upstream. Safe to poll from the dashboard.
//  Counters are process-local and reset on restart — long-term
//  attribution lives in q365_data_feed_health.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import {
  getMonitorSnapshot,
  SLOW_REQUEST_MS,
  HIGH_ERROR_RATE,
} from '@/lib/monitor/apiMonitor';
import { getRecentTraces } from '@/lib/monitor/trace';
import { getProviderReport } from '@/lib/marketData/providerReport';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getQuotaReport } from '@/lib/monitor/apiQuota';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

type SystemStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

function deriveSystemStatus(args: {
  errorRate:     number;
  avgLatencyMs:  number;
  fallbackSpike: boolean;
  recentErrors:  number;
}): SystemStatus {
  if (args.errorRate >= 0.20)            return 'CRITICAL';
  if (args.recentErrors >= 5 && args.errorRate >= HIGH_ERROR_RATE) return 'CRITICAL';
  if (args.errorRate >= HIGH_ERROR_RATE) return 'DEGRADED';
  if (args.avgLatencyMs >= SLOW_REQUEST_MS * 2) return 'DEGRADED';
  if (args.fallbackSpike)                return 'DEGRADED';
  return 'HEALTHY';
}

export async function GET(): Promise<Response> {
  const snap   = getMonitorSnapshot();
  const traces = getRecentTraces();
  const provReport = getProviderReport();
  const market = getMarketStatus();
  const quota  = await getQuotaReport();

  const providerSummary = (name: 'indianapi' | 'nse' | 'yahoo' | 'snapshot') => {
    const p = snap.providers.find((x) => x.provider === name);
    return {
      calls:        p?.calls        ?? 0,
      errors:       p?.errors       ?? 0,
      avg_latency:  p?.avgLatencyMs ?? 0,
      max_latency:  p?.maxLatencyMs ?? 0,
      error_rate:   Number((p?.errorRate ?? 0).toFixed(4)),
      last_error:   p?.lastErrorCode ?? null,
      last_call_at: p?.lastCallAt   ?? null,
    };
  };

  let systemStatus = deriveSystemStatus({
    errorRate:     snap.errorRate,
    avgLatencyMs:  snap.avgLatencyMs,
    fallbackSpike: snap.flags.fallbackSpike,
    recentErrors:  snap.errorLog.length,
  });
  // Spec QUOTA_TRACKING — quota state escalates the overall system
  // status. Burning through the quota is itself an outage condition
  // even when latency / errors look fine.
  if (quota.state === 'BLOCKED' || quota.state === 'CRITICAL') systemStatus = 'CRITICAL';
  else if (quota.state === 'WARNING' && systemStatus === 'HEALTHY') systemStatus = 'DEGRADED';

  const body = {
    system_status: systemStatus,
    last_updated_at: new Date().toISOString(),

    // ── Spec §9 — market awareness ─────────────────────────────
    market_state: market.state,
    mode:         market.isOpen ? 'live' : 'closed',
    market_label: market.label,
    data_source:  provReport.last_provider,

    // ── Spec §1, §3, §4 — global counters ──────────────────────
    total_requests:        snap.totalRequests,
    total_requests_today:  snap.daily.total,
    requests_last_minute:  snap.requestsLastMinute,
    avg_latency_ms:        snap.avgLatencyMs,
    max_latency_ms:        snap.maxLatencyMs,
    error_rate:            Number(snap.errorRate.toFixed(4)),
    errors_today:          snap.daily.errors,
    fallback_triggered:    provReport.fallback_triggered,
    fallbacks_today:       snap.daily.fallbacks,
    last_error:            provReport.last_error,

    // ── Spec §1, §4 — per-route and per-provider breakdowns ───
    daily: snap.daily,
    routes: snap.routes,
    providers: {
      indianapi: providerSummary('indianapi'),
      nse:       providerSummary('nse'),
      yahoo:     providerSummary('yahoo'),
      snapshot:  providerSummary('snapshot'),
    },

    // ── Spec §5 — workflow traces ──────────────────────────────
    recent_traces: traces.slice(0, 10).map((t) => ({
      id:         t.id,
      route:      t.route,
      started_at: t.startedAt,
      total_ms:   t.totalMs,
      summary:    t.summary,
      steps:      t.steps,
    })),

    // ── Spec §10 — performance flags ───────────────────────────
    flags: {
      slow_api:        snap.flags.slowApi,
      high_error_rate: snap.flags.highErrorRate,
      fallback_spike:  snap.flags.fallbackSpike,
      slow_threshold_ms: SLOW_REQUEST_MS,
      error_threshold:   HIGH_ERROR_RATE,
    },

    // ── Spec §1 — slow + error logs ────────────────────────────
    slow_requests: snap.slowRequests,
    error_log:     snap.errorLog,
    fallback_log:  snap.fallbackLog,

    // ── Spec QUOTA_TRACKING — IndianAPI usage vs IST limits ────
    quota,

    // ── Process info ───────────────────────────────────────────
    process_started_at: snap.processStartedAt,
    last_request_at:    snap.lastRequestAt,
  };

  return NextResponse.json(body, {
    status:  200,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
