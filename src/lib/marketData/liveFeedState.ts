// ════════════════════════════════════════════════════════════════
//  liveFeedState — institutional live-feed health tracker
//
//  Tracks the upstream poll loop (removed vendor → tickBus → WS fan-out)
//  and classifies freshness during market hours:
//    fresh        — ticks arriving within DELAYED_MS
//    delayed      — no tick for DELAYED_MS … STALE_MS
//    stale        — no tick for > STALE_MS (approvals blocked)
//    disconnected — poll loop stopped or repeated upstream errors
//
//  Off-hours the feed is always `closed_market` regardless of age.
// ════════════════════════════════════════════════════════════════

import { isMarketOpen } from '@/lib/marketData/marketHours';

export type LiveFeedQuality =
  | 'fresh'
  | 'delayed'
  | 'stale'
  | 'disconnected'
  | 'closed_market';

export type LiveFeedConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface LiveFeedStateSnapshot {
  quality:              LiveFeedQuality;
  connectionStatus:     LiveFeedConnectionStatus;
  /** Receipt time — when the server last ingested a tick. */
  lastReceivedAt:       number | null;
  /** Vendor quote timestamp (may lag receipt time on delayed feeds). */
  lastMarketDataAt:     number | null;
  lastMarketDataAgeMs:  number | null;
  lastTickAt:           number | null;
  lastTickAgeMs:        number | null;
  lastPollAt:           number | null;
  lastSuccessAt:        number | null;
  lastError:            string | null;
  consecutiveErrors:    number;
  ticksReceived:        number;
  pollCycles:           number;
  subscribedSymbols:    number;
  approvalsBlocked:     boolean;
  delayedThresholdMs:   number;
  staleThresholdMs:     number;
  marketOpen:           boolean;
  dataSource:           'live_tick' | 'daily';
  serverNow:            number;
}

const DELAYED_MS = Math.max(
  5_000,
  Number(process.env.LIVE_FEED_DELAYED_MS) || 45_000,
);
const STALE_MS = Math.max(
  DELAYED_MS + 1_000,
  Number(process.env.LIVE_FEED_STALE_MS) || 120_000,
);
const DISCONNECT_ERROR_THRESHOLD = Math.max(
  2,
  Number(process.env.LIVE_FEED_DISCONNECT_ERRORS) || 3,
);

interface MutableState {
  /** When the server last ingested a tick (receipt time — used for feed health). */
  lastReceivedAt:    number | null;
  /** Vendor quote timestamp of the most recent tick (may be delayed). */
  lastMarketDataAt:  number | null;
  /** @deprecated alias — kept for API compat; mirrors lastReceivedAt. */
  lastTickAt:        number | null;
  lastPollAt:        number | null;
  lastSuccessAt:     number | null;
  lastError:         string | null;
  consecutiveErrors: number;
  ticksReceived:     number;
  pollCycles:        number;
  subscribedSymbols: number;
  pollRunning:       boolean;
  reconnecting:      boolean;
}

const GLOBAL_KEY = '__q365_live_feed_state__';

function createState(): MutableState {
  return {
    lastReceivedAt:    null,
    lastMarketDataAt:  null,
    lastTickAt:        null,
    lastPollAt:        null,
    lastSuccessAt:     null,
    lastError:         null,
    consecutiveErrors: 0,
    ticksReceived:     0,
    pollCycles:        0,
    subscribedSymbols: 0,
    pollRunning:       false,
    reconnecting:      false,
  };
}

function state(): MutableState {
  const g = globalThis as unknown as Record<string, MutableState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createState();
  return g[GLOBAL_KEY]!;
}

/**
 * Record that a tick was ingested. Feed health uses `receivedAt` (default
 * now), NOT the vendor quote timestamp — Yahoo quotes can be ~15 min
 * delayed while the poll loop is still healthy.
 */
export function recordLiveFeedTick(receivedAt = Date.now(), marketDataAt?: number): void {
  const s = state();
  s.lastReceivedAt = receivedAt;
  s.lastTickAt = receivedAt;
  if (marketDataAt != null && Number.isFinite(marketDataAt)) {
    s.lastMarketDataAt = marketDataAt;
  }
  s.ticksReceived += 1;
  s.consecutiveErrors = 0;
  s.lastError = null;
}

export function recordLiveFeedPollStart(symbolCount: number): void {
  const s = state();
  s.lastPollAt = Date.now();
  s.subscribedSymbols = symbolCount;
  s.pollRunning = true;
}

export function recordLiveFeedPollSuccess(): void {
  const s = state();
  s.lastSuccessAt = Date.now();
  s.consecutiveErrors = 0;
  s.lastError = null;
  s.reconnecting = false;
  s.pollCycles += 1;
}

export function recordLiveFeedPollError(message: string): void {
  const s = state();
  s.lastError = message;
  s.consecutiveErrors += 1;
  if (s.consecutiveErrors >= DISCONNECT_ERROR_THRESHOLD) {
    s.reconnecting = true;
  }
  s.pollCycles += 1;
}

export function recordLiveFeedPollStopped(): void {
  state().pollRunning = false;
}

export function setLiveFeedReconnecting(active: boolean): void {
  state().reconnecting = active;
}

export function classifyLiveFeedQuality(now = Date.now()): LiveFeedQuality {
  if (!isMarketOpen()) return 'closed_market';
  const s = state();
  if (s.consecutiveErrors >= DISCONNECT_ERROR_THRESHOLD) return 'disconnected';

  // Freshness = most recent of tick receipt OR successful poll heartbeat.
  // Preferring only lastReceivedAt left the feed "stale" when WS was down
  // but REST polls were healthy (or when an old tick timestamp outlived
  // newer poll successes after OAuth reconnect).
  const receivedRef =
    s.lastReceivedAt != null && s.lastSuccessAt != null
      ? Math.max(s.lastReceivedAt, s.lastSuccessAt)
      : (s.lastReceivedAt ?? s.lastSuccessAt);
  if (receivedRef == null) {
    if (s.pollRunning || s.subscribedSymbols > 0) return 'delayed';
    return 'delayed';
  }

  const age = Math.max(0, now - receivedRef);
  if (age <= DELAYED_MS) return 'fresh';
  if (age <= STALE_MS)   return 'delayed';
  return 'stale';
}

export function getLiveFeedConnectionStatus(): LiveFeedConnectionStatus {
  const s = state();
  if (s.reconnecting || s.consecutiveErrors >= DISCONNECT_ERROR_THRESHOLD) {
    return 'reconnecting';
  }
  if (!s.pollRunning && s.subscribedSymbols === 0) return 'reconnecting';
  return 'connected';
}

/** True when signal approvals must be blocked due to feed health. */
export function liveFeedBlocksApprovals(now = Date.now()): boolean {
  if (!isMarketOpen()) return false;
  const q = classifyLiveFeedQuality(now);
  return q === 'stale' || q === 'disconnected';
}

/** Active candle source for the signal engine. */
export function resolveActiveCandleSource(): 'live_tick' | 'daily' {
  if (!isMarketOpen()) return 'daily';
  const q = classifyLiveFeedQuality();
  return q === 'fresh' || q === 'delayed' ? 'live_tick' : 'daily';
}

export function getLiveFeedState(now = Date.now()): LiveFeedStateSnapshot {
  const s = state();
  const marketOpen = isMarketOpen();
  const quality = classifyLiveFeedQuality(now);
  const receivedRef =
    s.lastReceivedAt != null && s.lastSuccessAt != null
      ? Math.max(s.lastReceivedAt, s.lastSuccessAt)
      : (s.lastReceivedAt ?? s.lastSuccessAt);
  const receivedAge = receivedRef != null ? now - receivedRef : null;
  const marketDataAge = s.lastMarketDataAt != null ? now - s.lastMarketDataAt : null;

  return {
    quality,
    connectionStatus: getLiveFeedConnectionStatus(),
    lastReceivedAt:   s.lastReceivedAt,
    lastMarketDataAt: s.lastMarketDataAt,
    lastMarketDataAgeMs: marketDataAge,
    lastTickAt:       s.lastReceivedAt,
    lastTickAgeMs:    receivedAge,
    lastPollAt:       s.lastPollAt,
    lastSuccessAt:    s.lastSuccessAt,
    lastError:        s.lastError,
    consecutiveErrors: s.consecutiveErrors,
    ticksReceived:    s.ticksReceived,
    pollCycles:       s.pollCycles,
    subscribedSymbols: s.subscribedSymbols,
    approvalsBlocked: liveFeedBlocksApprovals(now),
    delayedThresholdMs: DELAYED_MS,
    staleThresholdMs:   STALE_MS,
    marketOpen,
    dataSource: resolveActiveCandleSource(),
    serverNow: now,
  };
}

/** Test helper */
export function _resetLiveFeedStateForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
}
