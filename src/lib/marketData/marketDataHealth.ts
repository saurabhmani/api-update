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
//    health = 'OK'        → Kite is configured and healthy
//    health = 'DEGRADED'  → market closed OR Yahoo emergency fallback // @deprecated marker
//    health = 'FAIL'      → no provider at all
//
//  The shape is preserved for backwards compatibility with the
//  /api/market-data/health route.
// ════════════════════════════════════════════════════════════════

import { getMarketStatus } from './marketHours';
import {
  getMarketDataProvider,
  isYahooEmergencyFallbackEnabled,
} from './providerFlags';
import { getLiveMarketFeedStats } from './liveMarketFeed';
import { getStreamServerStats } from '@/lib/ws/streamServer';
import { getLiveFeedState } from './liveFeedState';
import { getKiteHealth, isKiteConfigured } from '@/lib/kite/health';

export type HealthState = 'OK' | 'DEGRADED' | 'FAIL';
export type HealthSource = 'kite' | 'yahoo' | 'none'; // @deprecated marker yahoo

export interface MarketDataHealth {
  health: HealthState;
  source: HealthSource;
  reason: string;
  /** Selected MARKET_DATA_PROVIDER (additive Phase 8). */
  current_provider?: string;

  tickRatePerSec: number;
  lastTickAgeMs:  number | null;
  subscribedCount: number;

  market: {
    isOpen: boolean;
    state: string;
    label: string;
  };
  // Retained for response-shape compatibility.
  ws: {
    state: string;
    loginRequired: boolean;
    lastConnectedAt: number | null;
    reconnectAttempts: number;
    lastError: string | null;
    port?: number;
    clientCount?: number;
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
  liveFeed: ReturnType<typeof getLiveFeedState>;
  liveFeedProvider: string;
  /** Phase 8 additive — null monthly quota for kite. */
  kite?: {
    configured: boolean;
    available: boolean;
    auth_failed: boolean;
    rate_limited: boolean;
  };
}

/**
 * Compute the coarse health summary. Pure in-memory read — no DB,
 * no network, no await. Safe to call from high-QPS endpoints.
 */
export function getMarketDataHealth(): MarketDataHealth {
  const mkt = getMarketStatus();
  const provider = getMarketDataProvider();
  const yahooEmergency = isYahooEmergencyFallbackEnabled(); // @deprecated marker
  const kiteHealth = getKiteHealth();
  const kiteConfigured = isKiteConfigured();

  const feed = getLiveMarketFeedStats();
  const ws = getStreamServerStats();
  const liveFeed = getLiveFeedState();

  let health: HealthState;
  let source: HealthSource;
  let reason: string;

  const liveProvider = feed.provider ?? 'kite';

  if (provider === 'kite' || provider === 'legacy') {
    if (!kiteConfigured) {
      if (yahooEmergency) {
        health = 'DEGRADED';
        source = 'yahoo';
        reason = 'KITE credentials missing — Yahoo emergency fallback active';
      } else {
        health = 'FAIL';
        source = 'none';
        reason = 'KITE_API_KEY missing or no active Kite session';
      }
    } else if (kiteHealth.auth_failed) {
      health = 'DEGRADED';
      source = 'kite';
      reason = 'Kite authentication failed';
    } else if (kiteHealth.rate_limited) {
      health = 'DEGRADED';
      source = 'kite';
      reason = 'Kite rate limit active';
    } else if (!mkt.isOpen) {
      health = 'DEGRADED';
      source = 'kite';
      reason = `Market closed (${mkt.label}) — Kite returns last close`;
    } else if (liveFeed.quality === 'stale' || liveFeed.quality === 'disconnected') {
      health = 'DEGRADED';
      source = liveProvider === 'yahoo' ? 'yahoo' : 'kite';
      reason = `Live feed ${liveFeed.quality} (${liveProvider}) — last tick ${liveFeed.lastTickAgeMs ?? '?'}ms ago`;
    } else {
      health = 'OK';
      source = liveProvider === 'yahoo' ? 'yahoo' : 'kite';
      reason = liveProvider === 'yahoo'
        ? `Yahoo live feed active (${liveFeed.quality})`
        : `Kite live feed configured (${liveFeed.quality})`;
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
    current_provider: provider,
    tickRatePerSec: feed.tickRatePerSec,
    lastTickAgeMs: feed.lastTickAgeMs,
    subscribedCount: feed.subscribedCount,
    market: {
      isOpen: mkt.isOpen,
      state: mkt.state,
      label: mkt.label,
    },
    ws: {
      state: ws.running ? 'open' : 'closed',
      loginRequired: false,
      lastConnectedAt: ws.lastConnectedAt,
      reconnectAttempts: ws.reconnectAttempts,
      lastError: ws.lastError ?? feed.lastError,
      port: ws.port,
      clientCount: ws.clientCount,
    },
    yahooFallback: {
      active: yahooEmergency && mkt.isOpen,
      activations: 0,
      recoveries: 0,
      cyclesRun: feed.cyclesRun,
      ticksEmitted: feed.lastTickTs != null ? 1 : 0,
    },
    marketOpenWatcher: {
      installed: feed.running,
      nextWakeAt: null,
      fires: feed.cyclesRun,
    },
    lastTickTs: feed.lastTickTs,
    serverNow: Date.now(),
    liveFeed,
    liveFeedProvider: liveProvider,
    kite: {
      configured: kiteConfigured,
      available: kiteHealth.available,
      auth_failed: kiteHealth.auth_failed,
      rate_limited: kiteHealth.rate_limited,
    },
  };
}
