// ════════════════════════════════════════════════════════════════
//  liveMarketFeed — server-side polling loop for subscribed symbols
//
//  Polls IndianAPI (via resolveBatch) for every symbol demanded by
//  WebSocket clients or HTTP /api/market-data/subscribe heartbeats,
//  then fans ticks into tickBus + tickPropagator so WS and SSE stay
//  in sync.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { propagateTick } from '@/lib/marketData/tickPropagator';
import { tickBus } from '@/lib/marketData/tickBus';
import { isMarketOpen } from '@/lib/marketData/marketHours';
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
  Number(process.env.INDIANAPI_EMULATED_BATCH_MAX) || 50,
);
const CLOSED_POLL_MS = Math.max(
  POLL_MS,
  Number(process.env.MARKET_FEED_CLOSED_POLL_MS) || 60_000,
);

/** HTTP view-demand expiry — symbol → expiresAt */
const demandExpiry = new Map<string, number>();
/** WS union — symbols any connected client asked for */
const wsSymbols = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let lastPollAt = 0;
let lastTickTs: number | null = null;
let ticksEmitted = 0;
let cyclesRun = 0;
let lastError: string | null = null;
let subscribedCount = 0;

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
  for (const [sym, exp] of demandExpiry) {
    if (exp <= now) demandExpiry.delete(sym);
  }
}

function activeSymbols(): string[] {
  pruneDemand();
  const set = new Set<string>(wsSymbols);
  for (const sym of demandExpiry.keys()) set.add(sym);
  subscribedCount = set.size;
  return [...set];
}

function publishTick(tick: MarketStreamTick): void {
  lastTickTs = tick.ts;
  ticksEmitted += 1;
  tickBus.emit(MARKET_TICK_EVENT, tick);
}

async function pollOnce(): Promise<void> {
  if (pollInFlight) return;
  const symbols = activeSymbols();
  if (symbols.length === 0) return;

  pollInFlight = true;
  lastPollAt = Date.now();
  try {
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
      }
    }
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log.warn('poll cycle failed', { error: lastError, symbols: symbols.length });
  } finally {
    pollInFlight = false;
    cyclesRun += 1;
  }
}

function ensurePollLoop(): void {
  if (pollTimer) return;
  const tick = () => { void pollOnce(); };
  tick();
  const interval = isMarketOpen() ? POLL_MS : CLOSED_POLL_MS;
  pollTimer = setInterval(tick, interval);
  log.info('poll loop started', { intervalMs: interval });
}

function stopPollLoop(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  log.info('poll loop stopped');
}

function syncPollLoop(): void {
  const symbols = activeSymbols();
  if (symbols.length === 0) {
    stopPollLoop();
    return;
  }
  if (!pollTimer) ensurePollLoop();
  else void pollOnce();
}

/** Register HTTP view-demand (subscribe route heartbeats). */
export function registerDemand(symbolsRaw: string[], ttlMs = DEMAND_TTL_MS): string[] {
  const now = Date.now();
  const added: string[] = [];
  for (const raw of symbolsRaw) {
    const sym = normalizeSymbol(raw);
    if (!sym) continue;
    demandExpiry.set(sym, now + ttlMs);
    if (!added.includes(sym)) added.push(sym);
  }
  syncPollLoop();
  return added;
}

/** Replace the WS union set (called by streamServer on client changes). */
export function setWsSymbolUnion(symbolsRaw: string[]): void {
  wsSymbols.clear();
  for (const raw of symbolsRaw) {
    const sym = normalizeSymbol(raw);
    if (sym) wsSymbols.add(sym);
  }
  syncPollLoop();
}

export function startLiveMarketFeed(): void {
  syncPollLoop();
  log.info('live market feed ready', { pollMs: POLL_MS });
}

export function stopLiveMarketFeed(): void {
  stopPollLoop();
  demandExpiry.clear();
  wsSymbols.clear();
  subscribedCount = 0;
}

export function getLiveMarketFeedStats() {
  const now = Date.now();
  const age = lastTickTs == null ? null : now - lastTickTs;
  const windowSec = Math.max(1, (now - (lastPollAt || now)) / 1000);
  return {
    subscribedCount,
    lastTickTs,
    lastTickAgeMs: age,
    tickRatePerSec: ticksEmitted > 0 && age != null && age < 10_000
      ? Math.min(ticksEmitted, subscribedCount) / windowSec
      : 0,
    cyclesRun,
    lastError,
    pollMs: isMarketOpen() ? POLL_MS : CLOSED_POLL_MS,
    running: pollTimer != null,
  };
}

/** Test helper */
export function _resetLiveMarketFeedForTests(): void {
  stopLiveMarketFeed();
  lastTickTs = null;
  ticksEmitted = 0;
  cyclesRun = 0;
  lastError = null;
}
