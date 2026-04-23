// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/health
//
//  Unified feed-health summary per the operator runbook. Returns:
//    {
//      health:         'OK' | 'DEGRADED' | 'FAIL',
//      source:         'kite' | 'yahoo' | 'none',
//      reason:         string,
//      tickRatePerSec: number,
//      lastTickAgeMs:  number | null,
//      subscribedCount: number,
//      market: { isOpen, state, label },
//      ws:     { state, loginRequired, lastConnectedAt, reconnectAttempts, lastError },
//      yahooFallback:     { active, activations, recoveries, cyclesRun, ticksEmitted },
//      marketOpenWatcher: { installed, nextWakeAt, fires },
//      lastTickTs:     number | null,
//      serverNow:      number
//    }
//
//  Cheap — pure in-memory read, no DB, no await. Safe to poll from
//  dashboards, monitors, or the UI banner at high frequency.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getMarketDataHealth } from '@/lib/marketData/marketDataHealth';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const data = getMarketDataHealth();

  // Always 200: HTTP status reflects whether the endpoint itself is
  // working, not whether the feed it reports on is healthy. Callers
  // that need to react to FAIL should read `data.health` from the
  // body — the old 503-on-FAIL mapping produced noisy dev-console
  // errors and tripped generic uptime probes even though the route
  // was responding correctly.
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
