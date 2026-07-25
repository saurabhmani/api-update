// ════════════════════════════════════════════════════════════════
//  liveMarketFeed — server-side polling loop for subscribed symbols
//
//  Polls Yahoo (default) or removed vendor for every symbol demanded by
//  WebSocket clients or HTTP /api/market-data/subscribe heartbeats,
//  then fans ticks into tickBus + tickPropagator so WS and SSE stay
//  in sync.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { getLiveFeedProvider, isDualSourceEnabled } from '@/lib/marketData/providerFlags';
import { normalizedToMarketSnapshot } from '@/lib/marketData/dualSource/feedNormalizer';
import { fetchYahooPublicQuotesBatch, type YahooPublicQuote } from '@/lib/marketData/yahooChartPublic';
import { propagateTick } from '@/lib/marketData/tickPropagator';
import { tickBus } from '@/lib/marketData/tickBus';
import { getTicker, type Tick as KiteTick } from '@/lib/marketData/kiteTicker';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { getBaselineSymbols } from '@/lib/marketData/liveFeedBaseline';
import {
  recordLiveFeedPollStart,
  recordLiveFeedPollSuccess,
  recordLiveFeedPollError,
  recordLiveFeedPollStopped,
  recordLiveFeedTick,
  setLiveFeedReconnecting,
} from '@/lib/marketData/liveFeedState';
import type { MarketSnapshot } from '@/types/market';
import {
  MARKET_TICK_EVENT,
  type MarketStreamTick,
} from '@/lib/marketData/marketStreamTypes';

const log = logger.child({ component: 'liveMarketFeed' });

const POLL_MS = Math.max(
  500,
  Number(process.env.MARKET_FEED_POLL_MS) || 2_000,
);
const DEMAND_TTL_MS = Math.max(
  30_000,
  Number(process.env.MARKET_FEED_DEMAND_TTL_MS) || 120_000,
);
const BATCH_SIZE = Math.max(
  1,
  Number(process.env.LEGACY_VENDOR_ENV) || 50,
);
const YAHOO_CONCURRENCY = Math.max(
  1,
  Math.min(20, Number(process.env.YAHOO_LIVE_CONCURRENCY) || 10),
);
const YAHOO_GAP_MS = Math.max(0, Number(process.env.YAHOO_LIVE_GAP_MS) || 120);
const CLOSED_POLL_MS = Math.max(
  POLL_MS,
  Number(process.env.MARKET_FEED_CLOSED_POLL_MS) || 60_000,
);

const GLOBAL_KEY = '__q365_live_market_feed__';

interface LiveMarketFeedGlobal {
  demandExpiry: Map<string, number>;
  wsSymbols: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  pollIntervalMs: number;
  pollInFlight: boolean;
  lastPollAt: number;
  lastTickTs: number | null;
  ticksEmitted: number;
  cyclesRun: number;
  lastError: string | null;
  subscribedCount: number;
  lastActiveSymbols: Set<string>;
}

function createFeedGlobal(): LiveMarketFeedGlobal {
  return {
    demandExpiry: new Map(),
    wsSymbols: new Set(),
    pollTimer: null,
    pollIntervalMs: 0,
    pollInFlight: false,
    lastPollAt: 0,
    lastTickTs: null,
    ticksEmitted: 0,
    cyclesRun: 0,
    lastError: null,
    subscribedCount: 0,
    lastActiveSymbols: new Set(),
  };
}

function feed(): LiveMarketFeedGlobal {
  const g = globalThis as unknown as Record<string, LiveMarketFeedGlobal | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createFeedGlobal();
  return g[GLOBAL_KEY]!;
}

function normalizeSymbol(raw: string): string | null {
  const up = String(raw ?? '').trim().toUpperCase();
  if (!up) return null;
  // Accept Upstox-style keys and colon-prefixed aliases.
  if (up.includes('|')) return up.split('|').pop()!.trim() || null;
  if (up.includes(':')) return up.split(':').pop()!.trim() || null;
  return up;
}

function snapshotToStreamTick(snap: MarketSnapshot, source: string): MarketStreamTick {
  const ts = snap.timestamp && snap.timestamp > 0 ? snap.timestamp : Date.now();
  return {
    symbol:  snap.symbol.toUpperCase(),
    price:   snap.price,
    change:  Number.isFinite(snap.change) ? snap.change : null,
    pChange: Number.isFinite(snap.changePercent) ? snap.changePercent : null,
    open:    Number.isFinite(snap.open) ? snap.open : null,
    high:    Number.isFinite(snap.high) ? snap.high : null,
    low:     Number.isFinite(snap.low) ? snap.low : null,
    close:   Number.isFinite(snap.prevClose) ? snap.prevClose : null,
    volume:  Number.isFinite(snap.volume) ? snap.volume : null,
    source,
    ts,
  };
}

function resolverRowToSnapshot(sym: string, row: {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
  source: string;
}): MarketSnapshot {
  const price = row.ltp;
  const prevClose = row.close;
  const change = Number.isFinite(prevClose) && prevClose > 0
    ? price - prevClose
    : 0;
  const changePercent = Number.isFinite(prevClose) && prevClose > 0
    ? (change / prevClose) * 100
    : 0;
  const ts = Date.parse(row.timestamp);
  return {
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent,
    volume: row.volume,
    open: row.open,
    high: row.high,
    low: row.low,
    prevClose,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  };
}

function pruneDemand(now = Date.now()): void {
  const store = feed();
  for (const [sym, exp] of store.demandExpiry) {
    if (exp <= now) store.demandExpiry.delete(sym);
  }
}

function activeSymbols(): string[] {
  const store = feed();
  pruneDemand();
  const set = new Set<string>(store.wsSymbols);
  for (const sym of store.demandExpiry.keys()) set.add(sym);
  if (isMarketOpen()) {
    for (const sym of getBaselineSymbols()) set.add(sym);
  }
  store.subscribedCount = set.size;
  return [...set];
}

function publishTick(tick: MarketStreamTick): void {
  const store = feed();
  const receivedAt = Date.now();
  store.lastTickTs = receivedAt;
  store.ticksEmitted += 1;
  recordLiveFeedTick(receivedAt, tick.ts);
  tickBus.emit(MARKET_TICK_EVENT, tick);
}

function yahooQuoteToSnapshot(q: YahooPublicQuote): MarketSnapshot {
  return {
    symbol:        q.symbol,
    price:         q.lastPrice,
    ltp:           q.lastPrice,
    change:        q.change,
    changePercent: q.pChange,
    volume:        q.volume,
    open:          q.open,
    high:          q.dayHigh,
    low:           q.dayLow,
    prevClose:     q.previousClose,
    timestamp:     q.timestamp,
  };
}

async function polllegacy_vendorBatch(symbols: string[]): Promise<number> {
  let published = 0;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const result = await resolveBatch(batch, { quiet: true });
    for (const sym of batch) {
      const row = result.data[`NSE:${sym}`];
      if (!row || !Number.isFinite(row.ltp) || row.ltp <= 0) continue;
      const snap = resolverRowToSnapshot(sym, row);
      const tick = snapshotToStreamTick(snap, row.source);
      publishTick(tick);
      void propagateTick(snap);
      published += 1;
    }
  }
  return published;
}

async function pollDualSourceBatch(symbols: string[]): Promise<number> {
  const { ingestDualSourceBatch } = await import('@/lib/marketData/dualSource/dataSourceManager');
  const results = await ingestDualSourceBatch(symbols);
  let published = 0;
  for (const row of results) {
    if (!row.publishTick) continue;
    const snap = normalizedToMarketSnapshot(row.publishTick);
    const source = `dual:${row.validation.status}`;
    const tick = snapshotToStreamTick(snap, source);
    publishTick(tick);
    if (row.approval.allowed) {
      void propagateTick(snap);
      published += 1;
    }
  }
  return published;
}

async function pollYahooBatch(symbols: string[]): Promise<number> {
  const quotes = await fetchYahooPublicQuotesBatch(symbols, {
    concurrency: YAHOO_CONCURRENCY,
    gapMs: YAHOO_GAP_MS,
  });
  let published = 0;
  for (const q of quotes) {
    const snap = yahooQuoteToSnapshot(q);
    const tick = snapshotToStreamTick(snap, 'yahoo');
    publishTick(tick);
    void propagateTick(snap);
    published += 1;
  }
  return published;
}

async function pollOnce(): Promise<void> {
  const store = feed();
  if (store.pollInFlight) return;
  const symbols = activeSymbols();
  if (symbols.length === 0) return;

  store.pollInFlight = true;
  store.lastPollAt = Date.now();
  recordLiveFeedPollStart(symbols.length);
  try {
    const provider = getLiveFeedProvider();
    const marketOpen = isMarketOpen();
    let published = 0;
    if (!marketOpen) {
      // Off-hours: daily bars are frozen, so never spend removed vendor
      // quota here — Yahoo's public chart API alone keeps last-close
      // prices flowing to the UI. This also protects the 16:00 IST
      // EOD candle cron from being starved by live-poll 429s.
      published = await pollYahooBatch(symbols);
    } else if (isDualSourceEnabled()) {
      published = await pollDualSourceBatch(symbols);
    } else if (provider === 'yahoo') {
      published = await pollYahooBatch(symbols);
    } else if (provider === 'kite') {
      const ticker = getTicker();
      if (ticker.getStatus().state !== 'open') {
        published = await polllegacy_vendorBatch(symbols);
      } else {
        published = symbols.length; // WS is active, ticks are streaming
      }
    } else {
      published = await polllegacy_vendorBatch(symbols);
      if (published === 0) published = await pollYahooBatch(symbols);
    }
    if (published === 0) {
      store.lastError = `no_ticks_${provider}`;
    } else {
      store.lastError = null;
    }
    recordLiveFeedPollSuccess();
    setLiveFeedReconnecting(false);
  } catch (err) {
    store.lastError = err instanceof Error ? err.message : String(err);
    recordLiveFeedPollError(store.lastError);
    log.warn('poll cycle failed', { error: store.lastError, symbols: symbols.length });
  } finally {
    store.pollInFlight = false;
    store.cyclesRun += 1;
  }
}

function desiredPollInterval(): number {
  return isMarketOpen() ? POLL_MS : CLOSED_POLL_MS;
}

function ensurePollLoop(): void {
  const store = feed();
  const interval = desiredPollInterval();
  if (store.pollTimer) {
    // Market open/closed transition: re-arm the timer at the new
    // cadence instead of keeping the boot-time interval forever.
    if (store.pollIntervalMs !== interval) {
      clearInterval(store.pollTimer);
      store.pollTimer = setInterval(() => { void pollOnce(); }, interval);
      store.pollIntervalMs = interval;
      log.info('poll loop interval adjusted', { intervalMs: interval, marketOpen: isMarketOpen() });
    }
    return;
  }
  const tick = () => { void pollOnce(); };
  recordLiveFeedPollStart(activeSymbols().length);
  tick();
  store.pollTimer = setInterval(tick, interval);
  store.pollIntervalMs = interval;
  log.info('poll loop started', { intervalMs: interval });
}

function stopPollLoop(): void {
  const store = feed();
  if (!store.pollTimer) return;
  clearInterval(store.pollTimer);
  store.pollTimer = null;
  store.pollIntervalMs = 0;
  recordLiveFeedPollStopped();
  log.info('poll loop stopped');
}

function syncPollLoop(): void {
  const store = feed();
  const symbols = activeSymbols();
  
  if (getLiveFeedProvider() === 'kite') {
    const nextSet = new Set(symbols);
    const toUnsubscribe: string[] = [];
    for (const sym of store.lastActiveSymbols) {
      if (!nextSet.has(sym)) toUnsubscribe.push(sym);
    }
    if (toUnsubscribe.length > 0) {
      getTicker().unsubscribeSymbols(toUnsubscribe).catch(() => {});
    }
    if (symbols.length > 0) {
      getTicker().subscribeSymbols(symbols, 'full').catch(() => {});
    }
    store.lastActiveSymbols = nextSet;
  }

  if (symbols.length === 0) {
    stopPollLoop();
    return;
  }
  const hadTimer = store.pollTimer != null;
  ensurePollLoop();
  if (hadTimer) void pollOnce();
}

/** Register HTTP view-demand (subscribe route heartbeats). */
export function registerDemand(symbolsRaw: string[], ttlMs = DEMAND_TTL_MS): string[] {
  const store = feed();
  const now = Date.now();
  const added: string[] = [];
  for (const raw of symbolsRaw) {
    const sym = normalizeSymbol(raw);
    if (!sym) continue;
    store.demandExpiry.set(sym, now + ttlMs);
    if (!added.includes(sym)) added.push(sym);
  }
  syncPollLoop();
  return added;
}

/** Replace the WS union set (called by streamServer on client changes). */
export function setWsSymbolUnion(symbolsRaw: string[]): void {
  const store = feed();
  store.wsSymbols.clear();
  for (const raw of symbolsRaw) {
    const sym = normalizeSymbol(raw);
    if (sym) store.wsSymbols.add(sym);
  }
  syncPollLoop();
}

export function startLiveMarketFeed(): void {
  const store = feed();
  syncPollLoop();
  
  if (getLiveFeedProvider() === 'kite') {
    const ticker = getTicker();
    ticker.connect().catch(err => log.error('Failed to connect kite ticker', { error: err }));

    // Attach the fan-out listener once per process — repeated startLiveMarketFeed
    // calls (or ensureStreaming + instrumentation) must not stack handlers.
    if (!(store as { __ticksListenerInstalled?: boolean }).__ticksListenerInstalled) {
      (store as { __ticksListenerInstalled?: boolean }).__ticksListenerInstalled = true;
      ticker.on('ticks', (ticks: KiteTick[]) => {
        for (const t of ticks) {
          if (!t.symbol) continue;
          const snap: MarketSnapshot = {
            symbol: t.symbol,
            price: t.lastPrice,
            ltp: t.lastPrice,
            change: t.change ?? 0,
            changePercent: t.pChange ?? 0,
            volume: t.volume ?? 0,
            open: t.open ?? t.lastPrice,
            high: t.high ?? t.lastPrice,
            low: t.low ?? t.lastPrice,
            prevClose: t.close ?? t.lastPrice,
            timestamp: t.ts,
          };
          const streamTick = snapshotToStreamTick(snap, 'kite-ws');
          publishTick(streamTick);
          void propagateTick(snap);
        }
      });
    }
  }

  if (isMarketOpen()) {
    void import('@/lib/marketData/liveFeedBaseline').then((m) => m.refreshLiveFeedBaseline());
  }
  log.info('live market feed ready', {
    pollMs: POLL_MS,
    provider: isDualSourceEnabled() ? 'dual' : getLiveFeedProvider(),
  });
}

export function stopLiveMarketFeed(): void {
  const store = feed();
  stopPollLoop();
  if (getLiveFeedProvider() === 'kite') {
    getTicker().disconnect().catch(() => {});
  }
  store.demandExpiry.clear();
  store.wsSymbols.clear();
  store.lastActiveSymbols.clear();
  store.subscribedCount = 0;
}

export function getLiveMarketFeedStats() {
  const store = feed();
  const now = Date.now();
  const age = store.lastTickTs == null ? null : now - store.lastTickTs;
  const windowSec = Math.max(1, (now - (store.lastPollAt || now)) / 1000);
  return {
    subscribedCount: store.subscribedCount,
    lastTickTs: store.lastTickTs,
    lastTickAgeMs: age,
    tickRatePerSec: store.ticksEmitted > 0 && age != null && age < 10_000
      ? Math.min(store.ticksEmitted, store.subscribedCount) / windowSec
      : 0,
    cyclesRun: store.cyclesRun,
    lastError: store.lastError,
    pollMs: isMarketOpen() ? POLL_MS : CLOSED_POLL_MS,
    running: store.pollTimer != null,
    // Off-hours the loop always polls Yahoo only (no removed vendor quota
    // spend on frozen prices); dual applies during the live session.
    provider: !isMarketOpen()
      ? 'yahoo'
      : isDualSourceEnabled() ? 'dual' : getLiveFeedProvider(),
    dualSourceEnabled: isDualSourceEnabled(),
  };
}

/** Test helper */
export function _resetLiveMarketFeedForTests(): void {
  const store = feed();
  stopLiveMarketFeed();
  store.lastTickTs = null;
  store.ticksEmitted = 0;
  store.cyclesRun = 0;
  store.lastError = null;
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
}
