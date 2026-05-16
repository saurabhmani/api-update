// ════════════════════════════════════════════════════════════════
//  marketDataHealth — coarse "is the feed healthy" summary.
//
//  The fine-grained per-request observability lives in the
//  q365_data_feed_health table (Step 7) and is exposed at
//  GET /api/data-feed/health. This module is the *cheap* synchronous
//  version used by older UI widgets that only need a green/yellow/red
//  badge. It must not block, must not hit the network, and must not
//  read the DB.
//
//    health = 'OK'        → IndianAPI is the configured primary AND
//                           an INDIAN_API_KEY is present.
//    health = 'DEGRADED'  → market closed (expected silence) OR Yahoo // @deprecated marker
//                           emergency fallback is the only path left.
//    health = 'FAIL'      → no provider at all (operator misconfigured
//                           the env, or chose MARKET_DATA_PROVIDER=none).
//
//  The shape is preserved for backwards compatibility with the
//  /api/market-data/health route.
// ════════════════════════════════════════════════════════════════

import { getMarketStatus } from './marketHours';
import {
  getMarketDataProvider,
  isYahooEmergencyFallbackEnabled, // @deprecated marker
} from './providerFlags';

export type HealthState = 'OK' | 'DEGRADED' | 'FAIL';
export type HealthSource = 'indianapi' | 'yahoo' | 'none'; // @deprecated marker

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
  // Retained for response-shape compatibility. Kite has been removed, // @deprecated marker
  // so these fields are constant.
  ws: {
    state: string;
    loginRequired: boolean;
    lastConnectedAt: number | null;
    reconnectAttempts: number;
    lastError: string | null;
  };
  yahooFallback: { // @deprecated marker
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

function isIndianApiKeyPresent(): boolean {
  // Must mirror the env-var precedence used by `getIndianApiConfig`
  // (indianApiEndpoints.ts:51-55) which accepts THREE names:
  //   INDIANAPI_API_KEY   — the form ".env.example" / .env.local ships
  //   INDIANAPI_KEY       — older internal convention
  //   INDIAN_API_KEY      — original adapter env name
  // Until 2026-05-01 this probe only checked the latter two, so a
  // production install using the canonical INDIANAPI_API_KEY name
  // tripped a false "INDIAN_API_KEY missing" → health='FAIL' alarm
  // even though the adapter was making real calls successfully.
  const k = (
    process.env.INDIANAPI_API_KEY
    ?? process.env.INDIANAPI_KEY
    ?? process.env.INDIAN_API_KEY
    ?? ''
  ).trim();
  return k.length > 0;
}

/**
 * Compute the coarse health summary. Pure in-memory read — no DB,
 * no network, no await. Safe to call from high-QPS endpoints.
 */
export function getMarketDataHealth(): MarketDataHealth {
  const mkt = getMarketStatus();
  const provider = getMarketDataProvider();
  const indianKey = isIndianApiKeyPresent();
  const yahooEmergency = isYahooEmergencyFallbackEnabled(); // @deprecated marker

  let health: HealthState;
  let source: HealthSource;
  let reason: string;

  if (provider === 'indianapi' && indianKey) {
    if (!mkt.isOpen) {
      health = 'DEGRADED';
      source = 'indianapi';
      reason = `Market closed (${mkt.label}) — IndianAPI returns last close`;
    } else {
      health = 'OK';
      source = 'indianapi';
      reason = 'IndianAPI is the active primary live-quote source';
    }
  } else if (provider === 'indianapi' && !indianKey) {
    if (yahooEmergency) { // @deprecated marker
      health = 'DEGRADED';
      source = 'yahoo'; // @deprecated marker
      reason = 'INDIAN_API_KEY missing — running on Yahoo emergency fallback'; // @deprecated marker
    } else {
      health = 'FAIL';
      source = 'none';
      reason = 'INDIAN_API_KEY missing and YAHOO_EMERGENCY_FALLBACK_ENABLED=false';
    }
  } else if (provider === 'yahoo') { // @deprecated marker
    health = mkt.isOpen ? 'OK' : 'DEGRADED';
    source = 'yahoo'; // @deprecated marker
    reason = 'MARKET_DATA_PROVIDER=yahoo — running on Yahoo as primary (deprecated)'; // @deprecated marker
  } else {
    health = 'FAIL';
    source = 'none';
    reason = `MARKET_DATA_PROVIDER=${provider} — no live data source configured`;
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
    yahooFallback: { // @deprecated marker
      active: yahooEmergency && mkt.isOpen, // @deprecated marker
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
