// ════════════════════════════════════════════════════════════════
//  GET /api/kite/status
//
//  Lightweight, unauth health probe for the UI banner. Distinct
//  from /api/kite/diagnose which is heavier and requires a session.
//
//  Architecture freeze (Priority 0): Kite is broker/execution ONLY,
//  NOT market-data truth. This route therefore reports the broker
//  session health plus the in-process tick-store / ticker status —
//  it does NOT drive signal-critical decisions.
//
//  Performance rules (fixes the 18-second-per-poll bug seen in the
//  previous implementation):
//    • Cache the full response in-process for 5 seconds so multi-page
//      polling (dashboard + signals + admin) coalesces into one
//      upstream call per window.
//    • Hard 1-second timeout on any DB / broker-API await. On timeout
//      the route returns a "login_required" fallback rather than
//      blocking the UI.
//    • No module-load side effects. instrumentation.ts is responsible
//      for installing the tick-freshness guard and tick monitor at
//      boot; installing them on every request (as the old handler
//      did) was a slow-path bug.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getTicker } from '@/lib/marketData/kiteTicker';
import { getTickStore } from '@/lib/marketData/tickStore';
import { getKiteStatus } from '@/lib/marketData/kiteSession';
import { getMarketFreshness } from '@/lib/marketData/tickFreshnessGuard';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { toIST, toISTFull, toPair } from '@/lib/utils/istTime';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

// ── Response cache ────────────────────────────────────────────────
// 5-second window. Long enough that a page mount + sibling component
// + sibling tab all hit one computation; short enough that token
// expiry / WebSocket reconnection become visible within one full poll
// cycle (10s default in useKiteStatus).
const CACHE_TTL_MS = 5_000;
type CachedResponse = { at: number; body: Record<string, unknown> };
let cached: CachedResponse | null = null;

// ── Timeout wrapper ───────────────────────────────────────────────
// Guarantees no slow upstream (MySQL shim, Kite /user/profile) can
// block a status poll longer than the caller cares to wait.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    p.then(v => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    }).catch(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

async function buildStatus(): Promise<Record<string, unknown>> {
  // Fast, in-process calls — no IO.
  const ticker    = getTicker();
  const s         = ticker.getStatus();
  const tickStore = getTickStore();
  const freshness = getMarketFreshness();
  const mkt       = getMarketStatus();

  // Slow/blocking calls — hard capped. Anything that isn't back in
  // 1 second is treated as unavailable; the UI sees a clean degraded
  // state rather than a 18-second hang.
  const kiteAuth = await withTimeout(
    getKiteStatus(),
    1_000,
    'login_required' as const,
  );

  const nowMs  = Date.now();
  const lastTs = freshness.lastTickTs ?? null;
  const liveAgeMs = lastTs != null ? Math.max(0, nowMs - lastTs) : null;

  const tickRatePerSec: number =
    (s as unknown as { tickRatePerSec?: number; ratePerSec?: number }).tickRatePerSec ??
    (s as unknown as { ratePerSec?: number }).ratePerSec ??
    0;

  let realtimeOk: boolean;
  let realtimeReason: string;
  if (!mkt.isOpen) {
    realtimeOk = true;
    realtimeReason = 'Market Closed';
  } else if (!s.state || s.state !== 'open') {
    realtimeOk = false;
    realtimeReason = 'Kite WebSocket not connected';
  } else if (liveAgeMs == null) {
    realtimeOk = false;
    realtimeReason = 'No ticks received yet';
  } else if (liveAgeMs >= 2000) {
    realtimeOk = false;
    realtimeReason = `Stale: tickAge=${liveAgeMs}ms (>2000ms)`;
  } else if (tickRatePerSec <= 10) {
    realtimeOk = false;
    realtimeReason = `Low rate: ${tickRatePerSec}/sec (≤10)`;
  } else {
    realtimeOk = true;
    realtimeReason = 'OK';
  }

  const pair = toPair(lastTs);

  return {
    connected:       s.state === 'open',
    subscribedCount: s.subscribed,
    ticksReceived:   freshness.ticksReceived,
    lastTickTime:    pair.utc,
    lastTickTimeUTC: pair.utc,
    lastTickTimeIST: pair.ist,
    lastTickIST:     pair.ist,
    loginRequired:   s.loginRequired,

    marketState:     freshness.state,
    tickAgeMs:       liveAgeMs,
    tickRatePerSec,
    staleReason:     freshness.reason ?? null,
    marketHoursState: mkt.state,
    marketLabel:      mkt.label,
    marketIsOpen:     mkt.isOpen,

    realtimeOk,
    realtimeReason,

    serverNowUTC:     new Date(nowMs).toISOString(),
    serverNowIST:     toIST(nowMs),
    serverNowISTFull: toISTFull(nowMs),

    kiteAuth,
    // tokenAgeMinutes is intentionally omitted from the fast path —
    // it required a second DB query that duplicated work inside
    // getKiteStatus(). If the UI needs it, compute it there.
    tokenAgeMinutes: null,
    ticksCached:     s.ticksCached,
    tickStoreSize:   tickStore.size(),
    packetsReceived: s.packetsReceived,
    undersizedPackets: (s as unknown as { undersizedPackets?: number }).undersizedPackets ?? 0,
    lastConnectedAt: s.lastConnectedAt
      ? new Date(s.lastConnectedAt).toISOString()
      : null,
    lastConnectedAtIST: toIST(s.lastConnectedAt ?? null),
    lastError:       s.lastError,
  };
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.body, {
      headers: {
        'Cache-Control': 'no-store',
        'x-cache': 'hit',
      },
    });
  }

  const body = await buildStatus();
  cached = { at: now, body };

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store',
      'x-cache': 'miss',
    },
  });
}
