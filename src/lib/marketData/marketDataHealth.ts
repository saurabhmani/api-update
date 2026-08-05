/**
 * marketDataHealth — coarse feed health for UI badges.
 * IndianAPI warehouse mode — no Kite/Shoonya SDK probes.
 */

import { getMarketStatus } from './marketHours';
import {
  getMarketDataProvider,
  indianApiCredentialsPresent,
  isIndianApiEnabled,
  isYahooEmergencyFallbackEnabled,
} from './providerFlags';
import { getLiveMarketFeedStats } from './liveMarketFeed';
import { getStreamServerStats } from '@/lib/ws/streamServer';
import { getLiveFeedState } from './liveFeedState';

export type HealthState = 'OK' | 'DEGRADED' | 'FAIL';
export type HealthSource = 'indianapi' | 'yahoo' | 'none';

export interface MarketDataHealth {
  health: HealthState;
  source: HealthSource;
  reason: string;
  current_provider?: string;
  tickRatePerSec: number;
  lastTickAgeMs: number | null;
  subscribedCount: number;
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
    port?: number;
    clientCount?: number;
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
  liveFeed: ReturnType<typeof getLiveFeedState>;
  liveFeedProvider: string;
  indianapi?: {
    enabled: boolean;
    credentialsConfigured: boolean;
  };
}

export function getMarketDataHealth(): MarketDataHealth {
  const mkt = getMarketStatus();
  const provider = getMarketDataProvider();
  const yahooEmergency = isYahooEmergencyFallbackEnabled();
  const indianEnabled = isIndianApiEnabled();
  const indianCreds = indianApiCredentialsPresent();

  const feed = getLiveMarketFeedStats();
  const ws = getStreamServerStats();
  const liveFeed = getLiveFeedState();

  let health: HealthState;
  let source: HealthSource;
  let reason: string;

  if (provider === 'indianapi') {
    if (!indianEnabled || !indianCreds) {
      health = 'FAIL';
      source = 'none';
      reason = !indianEnabled
        ? 'INDIANAPI_ENABLED is not true'
        : 'INDIANAPI_API_KEY missing';
    } else if (!mkt.isOpen) {
      health = 'DEGRADED';
      source = 'indianapi';
      reason = `Market closed (${mkt.label}) — warehouse serves last close`;
    } else {
      health = 'OK';
      source = 'indianapi';
      reason = 'IndianAPI warehouse configured';
    }
  } else if (provider === 'yahoo') {
    health = mkt.isOpen ? 'OK' : 'DEGRADED';
    source = 'yahoo';
    reason = 'MARKET_DATA_PROVIDER=yahoo (deprecated)';
  } else {
    health = 'FAIL';
    source = 'none';
    reason = `MARKET_DATA_PROVIDER=${provider} — configure indianapi`;
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
    liveFeedProvider: 'indianapi',
    indianapi: {
      enabled: indianEnabled,
      credentialsConfigured: indianCreds,
    },
  };
}
