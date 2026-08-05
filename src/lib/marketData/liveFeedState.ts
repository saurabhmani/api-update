/**
 * liveFeedState — provider-aware live-feed freshness (Phase 8)
 *
 * Freshness is keyed by userId + provider (+ connection instance).
 * One user's Kite ticks must never freshen another user's Shoonya feed.
 *
 * Auth / socket connect alone must NOT mark a source as fresh.
 * Freshness uses:
 *   referenceTime = max(valid(lastReceivedAt), valid(lastSuccessAt))
 * where lastReceivedAt = tick ingestion, lastSuccessAt = successful
 * data poll (REST quotes) — never OAuth / socket auth.
 */

import { isMarketOpen } from '@/lib/marketData/marketHours';
import { getSystemMarketDataUserId } from '@/lib/marketData/systemFeed';
import type { BrokerProviderName } from '@/lib/marketData/brokerProvider/types';

export type LiveFeedProvider = BrokerProviderName; // 'zerodha' | 'shoonya'

export type LiveFeedStatus =
  | 'not_connected'
  | 'login_required'
  | 'connecting'
  | 'connected'
  | 'waiting_for_data'
  | 'fresh'
  | 'delayed'
  | 'stale'
  | 'closed_market'
  | 'error';

/** Canonical per-connection feed state (Phase 8). */
export interface LiveFeedState {
  userId: string;
  provider: LiveFeedProvider;
  status: LiveFeedStatus;
  lastReceivedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
}

export interface LiveFeedKey {
  userId: string;
  provider: LiveFeedProvider;
}

/** @deprecated Prefer LiveFeedStatus — kept for ops/signal envelope compat. */
export type LiveFeedQuality =
  | 'fresh'
  | 'delayed'
  | 'stale'
  | 'disconnected'
  | 'closed_market';

/** @deprecated Prefer LiveFeedStatus connecting/connected. */
export type LiveFeedConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

/** Legacy snapshot shape for existing health/signals APIs. */
export interface LiveFeedStateSnapshot {
  quality: LiveFeedQuality;
  connectionStatus: LiveFeedConnectionStatus;
  /** Phase 8 keyed status (preferred). */
  status: LiveFeedStatus;
  userId: string;
  provider: LiveFeedProvider;
  lastReceivedAt: number | null;
  lastMarketDataAt: number | null;
  lastMarketDataAgeMs: number | null;
  lastTickAt: number | null;
  lastTickAgeMs: number | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  ticksReceived: number;
  pollCycles: number;
  subscribedSymbols: number;
  approvalsBlocked: boolean;
  delayedThresholdMs: number;
  staleThresholdMs: number;
  marketOpen: boolean;
  dataSource: 'live_tick' | 'daily';
  serverNow: number;
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

/** Connection phase — auth/wire state, independent of data freshness. */
type ConnectionPhase =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'login_required'
  | 'error';

interface MutableEntry {
  userId: string;
  provider: LiveFeedProvider;
  phase: ConnectionPhase;
  lastReceivedAt: number | null;
  lastMarketDataAt: number | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  ticksReceived: number;
  pollCycles: number;
  subscribedSymbols: number;
  pollRunning: boolean;
  reconnecting: boolean;
}

const STORE_KEY = '__q365_live_feed_states__';

type FeedStore = Map<string, MutableEntry>;

function store(): FeedStore {
  const g = globalThis as unknown as Record<string, FeedStore | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY]!;
}

export function liveFeedKeyString(key: LiveFeedKey): string {
  return `${String(key.userId).trim()}:${key.provider}`;
}

export function parseLiveFeedKey(raw: string): LiveFeedKey | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const userId = raw.slice(0, idx).trim();
  const provider = raw.slice(idx + 1).trim().toLowerCase();
  if (!userId) return null;
  if (provider !== 'zerodha' && provider !== 'shoonya') return null;
  return { userId, provider };
}

/**
 * System jobs / process-global poll use the configured system owner.
 * Falls back to `__system__:zerodha` when SYSTEM_MARKET_DATA_USER_ID is unset.
 */
export function getSystemLiveFeedKey(): LiveFeedKey {
  const id = getSystemMarketDataUserId();
  return {
    userId: id != null ? String(id) : '__system__',
    provider: 'zerodha',
  };
}

function normalizeKey(key?: LiveFeedKey | null): LiveFeedKey {
  if (key?.userId && (key.provider === 'zerodha' || key.provider === 'shoonya')) {
    return { userId: String(key.userId).trim(), provider: key.provider };
  }
  return getSystemLiveFeedKey();
}

function createEntry(key: LiveFeedKey): MutableEntry {
  return {
    userId: key.userId,
    provider: key.provider,
    phase: 'not_connected',
    lastReceivedAt: null,
    lastMarketDataAt: null,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveErrors: 0,
    ticksReceived: 0,
    pollCycles: 0,
    subscribedSymbols: 0,
    pollRunning: false,
    reconnecting: false,
  };
}

function entry(key?: LiveFeedKey | null): MutableEntry {
  const k = normalizeKey(key);
  const map = store();
  const id = liveFeedKeyString(k);
  let e = map.get(id);
  if (!e) {
    e = createEntry(k);
    map.set(id, e);
  }
  return e;
}

export function isValidTimestamp(ts: number | null | undefined): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0;
}

/**
 * Shared freshness clock. Auth timestamps must never be passed here.
 */
export function liveFeedReferenceTime(input: {
  lastReceivedAt?: number | null;
  lastSuccessAt?: number | null;
}): number {
  return Math.max(
    isValidTimestamp(input.lastReceivedAt) ? input.lastReceivedAt : 0,
    isValidTimestamp(input.lastSuccessAt) ? input.lastSuccessAt : 0,
  );
}

function classifyStatus(e: MutableEntry, now = Date.now()): LiveFeedStatus {
  if (!isMarketOpen()) return 'closed_market';

  if (e.phase === 'login_required') return 'login_required';
  if (e.phase === 'error') return 'error';
  if (e.phase === 'not_connected') return 'not_connected';
  if (e.phase === 'connecting' || e.reconnecting) return 'connecting';

  if (e.consecutiveErrors >= DISCONNECT_ERROR_THRESHOLD) return 'error';

  const ref = liveFeedReferenceTime({
    lastReceivedAt: e.lastReceivedAt,
    lastSuccessAt: e.lastSuccessAt,
  });

  // Connected / auth ok but no tick and no successful data poll yet.
  if (ref <= 0) {
    return 'waiting_for_data';
  }

  const age = Math.max(0, now - ref);
  if (age <= DELAYED_MS) return 'fresh';
  if (age <= STALE_MS) return 'delayed';
  return 'stale';
}

function statusToLegacyQuality(status: LiveFeedStatus): LiveFeedQuality {
  switch (status) {
    case 'fresh':
      return 'fresh';
    case 'delayed':
    case 'waiting_for_data':
    case 'connected':
    case 'connecting':
      return 'delayed';
    case 'stale':
      return 'stale';
    case 'closed_market':
      return 'closed_market';
    case 'not_connected':
    case 'login_required':
    case 'error':
    default:
      return 'disconnected';
  }
}

function connectionStatusOf(e: MutableEntry, status: LiveFeedStatus): LiveFeedConnectionStatus {
  if (status === 'connecting' || e.reconnecting) return 'reconnecting';
  if (
    status === 'not_connected'
    || status === 'login_required'
    || status === 'error'
  ) {
    return 'disconnected';
  }
  return 'connected';
}

// ── Mutations ────────────────────────────────────────────────────

/**
 * Record a live tick for THIS user+provider only.
 * Does not touch any other connection's freshness.
 */
export function recordLiveFeedTick(
  receivedAt = Date.now(),
  marketDataAt?: number,
  key?: LiveFeedKey | null,
): void {
  const e = entry(key);
  e.lastReceivedAt = receivedAt;
  if (marketDataAt != null && Number.isFinite(marketDataAt)) {
    e.lastMarketDataAt = marketDataAt;
  }
  e.ticksReceived += 1;
  e.consecutiveErrors = 0;
  e.lastError = null;
  // Receiving data implies the wire is up.
  if (e.phase === 'not_connected' || e.phase === 'connecting') {
    e.phase = 'connected';
  }
  e.reconnecting = false;
}

/**
 * Successful REST/data poll heartbeat for THIS key.
 * Must NOT be called for OAuth or socket auth success.
 */
export function recordLiveFeedPollSuccess(key?: LiveFeedKey | null): void {
  const e = entry(key);
  e.lastSuccessAt = Date.now();
  e.consecutiveErrors = 0;
  e.lastError = null;
  e.reconnecting = false;
  e.pollCycles += 1;
  if (e.phase === 'not_connected' || e.phase === 'connecting') {
    e.phase = 'connected';
  }
}

export function recordLiveFeedPollStart(
  symbolCount: number,
  key?: LiveFeedKey | null,
): void {
  const e = entry(key);
  e.lastPollAt = Date.now();
  e.subscribedSymbols = symbolCount;
  e.pollRunning = true;
}

export function recordLiveFeedPollError(
  message: string,
  key?: LiveFeedKey | null,
): void {
  const e = entry(key);
  e.lastError = message;
  e.consecutiveErrors += 1;
  if (e.consecutiveErrors >= DISCONNECT_ERROR_THRESHOLD) {
    e.reconnecting = true;
    e.phase = 'connecting';
  }
  e.pollCycles += 1;
}

export function recordLiveFeedPollStopped(key?: LiveFeedKey | null): void {
  entry(key).pollRunning = false;
}

/**
 * Wire/lifecycle phase updates. Auth success → connected / waiting_for_data,
 * never fresh (no lastSuccessAt / lastReceivedAt write).
 */
export function setLiveFeedConnectionPhase(
  key: LiveFeedKey,
  phase: ConnectionPhase,
  errorMessage?: string | null,
): void {
  const e = entry(key);
  e.phase = phase;
  if (phase === 'connecting') {
    e.reconnecting = true;
  } else if (phase === 'connected') {
    e.reconnecting = false;
    e.lastError = null;
  } else if (phase === 'login_required' || phase === 'error') {
    e.reconnecting = false;
    if (errorMessage) e.lastError = errorMessage;
  } else if (phase === 'not_connected') {
    e.reconnecting = false;
  }
}

/** @deprecated Prefer setLiveFeedConnectionPhase(key, …). Keyed reconnect flag. */
export function setLiveFeedReconnecting(
  active: boolean,
  key?: LiveFeedKey | null,
): void {
  const e = entry(key);
  e.reconnecting = active;
  if (active) {
    e.phase = 'connecting';
  } else if (e.phase === 'connecting') {
    // Cleared reconnect without claiming data freshness.
    e.phase = 'connected';
  }
}

export function setLiveFeedLoginRequired(
  key: LiveFeedKey,
  message = 'login_required',
): void {
  setLiveFeedConnectionPhase(key, 'login_required', message);
}

// ── Reads ────────────────────────────────────────────────────────

export function getLiveFeedStateFor(
  key: LiveFeedKey,
  now = Date.now(),
): LiveFeedState {
  const e = entry(key);
  const status = classifyStatus(e, now);
  const out: LiveFeedState = {
    userId: e.userId,
    provider: e.provider,
    status,
  };
  if (isValidTimestamp(e.lastReceivedAt)) out.lastReceivedAt = e.lastReceivedAt;
  if (isValidTimestamp(e.lastSuccessAt)) out.lastSuccessAt = e.lastSuccessAt;
  if (e.lastError) out.lastError = e.lastError;
  return out;
}

export function listLiveFeedStates(now = Date.now()): LiveFeedState[] {
  return [...store().values()].map((e) =>
    getLiveFeedStateFor({ userId: e.userId, provider: e.provider }, now),
  );
}

/** @deprecated Prefer getLiveFeedStateFor(key). Defaults to system key. */
export function classifyLiveFeedQuality(
  now = Date.now(),
  key?: LiveFeedKey | null,
): LiveFeedQuality {
  return statusToLegacyQuality(classifyStatus(entry(key), now));
}

/** @deprecated Prefer getLiveFeedStateFor(key).status */
export function getLiveFeedConnectionStatus(
  key?: LiveFeedKey | null,
): LiveFeedConnectionStatus {
  const e = entry(key);
  return connectionStatusOf(e, classifyStatus(e));
}

export function liveFeedBlocksApprovals(
  now = Date.now(),
  key?: LiveFeedKey | null,
): boolean {
  if (!isMarketOpen()) return false;
  const status = classifyStatus(entry(key), now);
  return status === 'stale' || status === 'error' || status === 'login_required' || status === 'not_connected';
}

export function resolveActiveCandleSource(
  key?: LiveFeedKey | null,
): 'live_tick' | 'daily' {
  if (!isMarketOpen()) return 'daily';
  const status = classifyStatus(entry(key));
  return status === 'fresh' || status === 'delayed' ? 'live_tick' : 'daily';
}

/**
 * Legacy snapshot for health APIs. Defaults to system key so jobs stay
 * isolated from interactive user streams.
 */
export function getLiveFeedState(
  now = Date.now(),
  key?: LiveFeedKey | null,
): LiveFeedStateSnapshot {
  const k = normalizeKey(key);
  const e = entry(k);
  const marketOpen = isMarketOpen();
  const status = classifyStatus(e, now);
  const quality = statusToLegacyQuality(status);
  const ref = liveFeedReferenceTime({
    lastReceivedAt: e.lastReceivedAt,
    lastSuccessAt: e.lastSuccessAt,
  });
  const receivedAge = ref > 0 ? now - ref : null;
  const marketDataAge = e.lastMarketDataAt != null ? now - e.lastMarketDataAt : null;

  return {
    quality,
    connectionStatus: connectionStatusOf(e, status),
    status,
    userId: e.userId,
    provider: e.provider,
    lastReceivedAt: e.lastReceivedAt,
    lastMarketDataAt: e.lastMarketDataAt,
    lastMarketDataAgeMs: marketDataAge,
    lastTickAt: e.lastReceivedAt,
    lastTickAgeMs: receivedAge,
    lastPollAt: e.lastPollAt,
    lastSuccessAt: e.lastSuccessAt,
    lastError: e.lastError,
    consecutiveErrors: e.consecutiveErrors,
    ticksReceived: e.ticksReceived,
    pollCycles: e.pollCycles,
    subscribedSymbols: e.subscribedSymbols,
    approvalsBlocked: liveFeedBlocksApprovals(now, k),
    delayedThresholdMs: DELAYED_MS,
    staleThresholdMs: STALE_MS,
    marketOpen,
    dataSource: resolveActiveCandleSource(k),
    serverNow: now,
  };
}

/** Test helper — clears all keyed states. */
export function _resetLiveFeedStateForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[STORE_KEY];
}
