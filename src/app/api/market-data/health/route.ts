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

  // HTTP status mirrors health for easy uptime-probe integration:
  //   200 — OK
  //   200 — DEGRADED (still serving data, don't want pagers firing)
  //   503 — FAIL    (feed is down; something should wake up)
  const status = data.health === 'FAIL' ? 503 : 200;

  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
