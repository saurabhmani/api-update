// ════════════════════════════════════════════════════════════════
//  marketDataHealth — the single authoritative "is the feed healthy"
//  answer for the whole system.
//
//  Spec contract (matches the operator runbook):
//    health = 'OK'        → real-time Kite ticks flowing, age ≤ 3s
//    health = 'DEGRADED'  → data is still flowing but via Yahoo
//                           fallback, or Kite ticks are 3–30s old,
//                           or the market is closed (expected — not
//                           an incident but also not real-time).
//    health = 'FAIL'      → market is OPEN, no usable data at all:
//                           no Kite ticks within 30s AND Yahoo is
//                           not (yet) producing, OR loginRequired.
//
//  source describes what the CURRENT tick cache is being fed by:
//    'kite'  → most recent tick on the bus came from Kite
//    'yahoo' → most recent tick came from the fallback poller
//    'none'  → no ticks at all since last boot
//
//  Consumers:
//    • /api/market-data/health route (this file's route.ts)
//    • health-aware UI widgets
//    • internal diagnostics / operator scripts
// ════════════════════════════════════════════════════════════════

import { getTicker } from './kiteTicker';
import { getMarketStatus } from './marketHours';
import { getMarketFreshness } from './tickFreshnessGuard';
import {
  getYahooFallbackStats,
} from './yahooFallbackPoller';
import {
  getMarketOpenWatcherStats,
} from './marketOpenWatcher';

export type HealthState = 'OK' | 'DEGRADED' | 'FAIL';
export type HealthSource = 'kite' | 'yahoo' | 'none';

export interface MarketDataHealth {
  // ── Top-line verdict ──
  health: HealthState;
  source: HealthSource;
  reason: string;

  // ── Required by spec ──
  tickRatePerSec: number;
  lastTickAgeMs:  number | null;
  subscribedCount: number;

  // ── Additional operator context ──
  market: {
    isOpen: boolean;
    state: string;
    label: string;
  };
  ws: {
    state: string;
    loginRequired: boolean;
    lastConnectedAt: number | null;
    reconnectAttempts: number;
    lastError: string | null;
  };
  yahooFallback: {
    active: boolean;
    activations: number;
    recoveries: number;
    cyclesRun: number;
    ticksEmitted: number;
  };
  marketOpenWatcher: {
    installed: boolean;
    nextWakeAt: number | null;
    fires: number;
  };
  lastTickTs: number | null;
  serverNow: number;
}

// Freshness cut-offs — single source of truth used by every caller.
// Kept in sync with the operator spec:
//   ≤ 3s   real-time
//   ≤ 30s  acceptable fallback
//   > 30s  fail (market must be OPEN)
const FRESH_MS = 3_000;
const STALE_MS = 30_000;

/**
 * Compute the unified health summary. Pure in-memory read — no DB,
 * no network, no await. Safe to call from high-QPS endpoints.
 */
export function getMarketDataHealth(): MarketDataHealth {
  const mkt    = getMarketStatus();
  const ticker = getTicker();
  const ts     = ticker.getStatus();
  const freshness = getMarketFreshness();
  const yahoo  = getYahooFallbackStats();
  const watcher = getMarketOpenWatcherStats();

  const lastTickTs = freshness.lastTickTs;
  const lastTickAgeMs = lastTickTs != null ? Date.now() - lastTickTs : null;
  const tickRatePerSec = ((): number => {
    const raw = (ts as any).tickRatePerSec;
    return typeof raw === 'number' ? raw : 0;
  })();

  let health: HealthState;
  let source: HealthSource;
  let reason: string;

  if (!mkt.isOpen) {
    // Outside session — expected silence. Not OK (not real-time) but
    // not FAIL either. DEGRADED by design.
    //
    // Source attribution precedence (after hours):
    //   1. Yahoo ACTIVELY polling   → 'yahoo' (honest: frames flowing
    //      onto the bus right now are yahoo-labeled).
    //   2. Any Kite data observed    → 'kite'  (either a live tick
    //      earlier in this session OR Kite ticks cached on the ticker
    //      via EOD seed / last session).
    //   3. Nothing at all            → 'none'.
    //
    // This prevents the "liveSource=yahoo" false positive the
    // operator reported: when the poller is OFF after hours but we
    // still have authoritative Kite data (seeded from market_data_daily
    // or cached from the prior session) the source correctly reads 'kite'.
    health = 'DEGRADED';
    if (yahoo.active) {
      source = 'yahoo';
    } else if (lastTickTs != null || ts.ticksCached > 0) {
      source = 'kite';
    } else {
      source = 'none';
    }
    reason = `Market closed (${mkt.label})`;
  } else if (ts.loginRequired) {
    // Market is open and we can't even connect. Hard fail regardless
    // of whether Yahoo is carrying the load — operator intervention
    // required.
    health = 'FAIL';
    source = yahoo.active ? 'yahoo' : 'none';
    reason = 'Kite access_token invalid — visit /api/kite/login';
  } else if (yahoo.active) {
    // Yahoo poller has taken over. Data is flowing; it's just not
    // real-time. Surface clearly so the operator sees the reason.
    health = 'DEGRADED';
    source = 'yahoo';
    reason = lastTickAgeMs == null
      ? 'Yahoo fallback active; no Kite tick since boot'
      : `Yahoo fallback active; last Kite tick ${Math.round(lastTickAgeMs / 1000)}s ago`;
  } else if (lastTickTs == null) {
    // Market open, no fallback, no tick yet. Treat as FAIL — we're
    // not delivering data.
    health = 'FAIL';
    source = 'none';
    reason = 'No ticks received yet since boot';
  } else if (lastTickAgeMs != null && lastTickAgeMs <= FRESH_MS) {
    health = 'OK';
    source = 'kite';
    reason = `Live — age ${lastTickAgeMs}ms, rate ${tickRatePerSec}/sec`;
  } else if (lastTickAgeMs != null && lastTickAgeMs <= STALE_MS) {
    // Between 3s and 30s — aging but not yet a fallback trigger.
    health = 'DEGRADED';
    source = 'kite';
    reason = `Kite slow — last tick ${(lastTickAgeMs / 1000).toFixed(1)}s ago`;
  } else {
    // Kite silent > 30s during market hours but the Yahoo poller
    // hasn't activated yet (race window between stale detection and
    // the health-check timer). FAIL.
    health = 'FAIL';
    source = 'none';
    reason = `Kite silent for ${Math.round((lastTickAgeMs ?? 0) / 1000)}s; no fallback yet`;
  }

  return {
    health,
    source,
    reason,
    tickRatePerSec,
    lastTickAgeMs,
    subscribedCount: ts.subscribed,
    market: {
      isOpen: mkt.isOpen,
      state: mkt.state,
      label: mkt.label,
    },
    ws: {
      state: ts.state,
      loginRequired: ts.loginRequired,
      lastConnectedAt: ts.lastConnectedAt ?? null,
      reconnectAttempts: ts.reconnectAttempts,
      lastError: ts.lastError,
    },
    yahooFallback: {
      active: yahoo.active,
      activations: yahoo.activations,
      recoveries: yahoo.recoveries,
      cyclesRun: yahoo.cycles,
      ticksEmitted: yahoo.emitted,
    },
    marketOpenWatcher: {
      installed: watcher.installed,
      nextWakeAt: watcher.nextWakeAt,
      fires: watcher.fires,
    },
    lastTickTs,
    serverNow: Date.now(),
  };
}
