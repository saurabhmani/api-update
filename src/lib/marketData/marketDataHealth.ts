// ════════════════════════════════════════════════════════════════
//  marketDataHealth — the single authoritative "is the feed healthy"
//  answer for the whole system.
//
//  Kite has been removed from the system. Yahoo Finance is now the
//  sole live-quote provider, pulled on demand per page poll (no
//  WebSocket, no tick bus). That makes "health" a much simpler
//  concept:
//
//    health = 'OK'        → market is open and Yahoo is reachable
//    health = 'DEGRADED'  → market is closed (expected silence)
//    health = 'FAIL'      → Yahoo is explicitly disabled (YAHOO_ENABLED=false)
//
//  The shape of the returned object is preserved for backward
//  compatibility with the /api/market-data/health route and any UI
//  widget that used to read it. Kite-specific fields are kept but
//  always report empty/disconnected values.
// ════════════════════════════════════════════════════════════════

import { getMarketStatus } from './marketHours';

export type HealthState = 'OK' | 'DEGRADED' | 'FAIL';
export type HealthSource = 'yahoo' | 'none';

export interface MarketDataHealth {
  health: HealthState;
  source: HealthSource;
  reason: string;

  tickRatePerSec: number;
  lastTickAgeMs:  number | null;
  subscribedCount: number;

  market: {
    isOpen: boolean;
    state: string;
    label: string;
  };
  // Retained for response-shape compatibility. Kite has been removed,
  // so these fields are constant.
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

const YAHOO_ENABLED =
  (process.env.YAHOO_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * Compute the unified health summary. Pure in-memory read — no DB,
 * no network, no await. Safe to call from high-QPS endpoints.
 */
export function getMarketDataHealth(): MarketDataHealth {
  const mkt = getMarketStatus();

  let health: HealthState;
  let source: HealthSource;
  let reason: string;

  if (!YAHOO_ENABLED) {
    health = 'FAIL';
    source = 'none';
    reason = 'Yahoo is disabled (YAHOO_ENABLED=false) — no live data source configured';
  } else if (!mkt.isOpen) {
    health = 'DEGRADED';
    source = 'yahoo';
    reason = `Market closed (${mkt.label}) — Yahoo will return last close`;
  } else {
    health = 'OK';
    source = 'yahoo';
    reason = 'Yahoo Finance is the active live-quote source';
  }

  return {
    health,
    source,
    reason,
    tickRatePerSec: 0,
    lastTickAgeMs: null,
    subscribedCount: 0,
    market: {
      isOpen: mkt.isOpen,
      state: mkt.state,
      label: mkt.label,
    },
    ws: {
      state: 'removed',
      loginRequired: false,
      lastConnectedAt: null,
      reconnectAttempts: 0,
      lastError: null,
    },
    yahooFallback: {
      active: YAHOO_ENABLED && mkt.isOpen,
      activations: 0,
      recoveries: 0,
      cyclesRun: 0,
      ticksEmitted: 0,
    },
    marketOpenWatcher: {
      installed: false,
      nextWakeAt: null,
      fires: 0,
    },
    lastTickTs: null,
    serverNow: Date.now(),
  };
}
