// ════════════════════════════════════════════════════════════════
//  GET /api/debug/provider-report
//
//  Spec SMART_FALLBACK §7 — surfaces the in-process provider counters
//  maintained by `@/lib/marketData/providerReport`. Returns:
//    {
//      last_provider:      "indianapi" | "nse" | "yahoo" | "snapshot" | null,
//      indianapi_calls:    number,
//      nse_calls:          number,
//      yahoo_calls:        number,
//      snapshot_calls:     number,
//      fallback_triggered: boolean,
//      last_error:         string | null,
//      providers:          { <name>: { calls, errors, avg_latency, ... } }
//    }
//
//  The endpoint is read-only, never calls upstream, and is safe to
//  poll. The cumulative counters come from providerReport (preserved
//  for backwards compat with anything already polling this route);
//  the `providers` block adds the per-provider latency + error rollup
//  from the API health monitor (spec API_HEALTH_MONITOR §7).
//
//  Counters are process-local and reset on restart. For long-term
//  attribution, query q365_data_feed_health (populated per-call by
//  the resolver via logFeedHealth).
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getProviderReport } from '@/lib/marketData/providerReport';
import { getMonitorSnapshot, type MonitorProvider } from '@/lib/monitor/apiMonitor';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const r = getProviderReport();
  const snap = getMonitorSnapshot();

  const summarize = (name: MonitorProvider) => {
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

  return NextResponse.json(
    {
      last_provider:      r.last_provider,
      indianapi_calls:    r.indianapi_calls,
      nse_calls:          r.nse_calls,
      yahoo_calls:        r.yahoo_calls,
      snapshot_calls:     r.snapshot_calls,
      fallback_triggered: r.fallback_triggered,
      last_error:         r.last_error,
      last_updated_at:    r.last_updated_at,
      providers: {
        indianapi: summarize('indianapi'),
        nse:       summarize('nse'),
        yahoo:     summarize('yahoo'),
        snapshot:  summarize('snapshot'),
      },
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
