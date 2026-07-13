// Normalize vendor-specific snapshots into NormalizedFeedTick.

import type { MarketSnapshot } from '@/types/market';
import type { YahooPublicQuote } from '@/lib/marketData/yahooChartPublic';
import type { FeedSourceId, NormalizedFeedTick } from './types';

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeFromMarketSnapshot(
  snap: MarketSnapshot,
  source: FeedSourceId,
  receivedAt = Date.now(),
  latencyMs = 0,
): NormalizedFeedTick | null {
  const sym = String(snap.symbol ?? '').trim().toUpperCase();
  const ltp = num(snap.ltp ?? snap.price);
  if (!sym || ltp <= 0) return null;

  const ts = num(snap.timestamp, receivedAt);
  return {
    symbol: sym,
    exchange: 'NSE',
    source,
    ltp,
    open: num(snap.open, ltp),
    high: num(snap.high, ltp),
    low: num(snap.low, ltp),
    close: num(snap.prevClose, ltp),
    volume: num(snap.volume),
    bid: null,
    ask: null,
    change: num(snap.change),
    changePercent: num(snap.changePercent),
    sourceTimestamp: ts,
    receivedAt,
    latencyMs,
  };
}

export function normalizeFromYahooQuote(
  q: YahooPublicQuote,
  receivedAt = Date.now(),
  latencyMs = 0,
): NormalizedFeedTick | null {
  const sym = String(q.symbol ?? '').trim().toUpperCase();
  if (!sym || q.lastPrice <= 0) return null;

  return {
    symbol: sym,
    exchange: 'NSE',
    source: 'yahoo',
    ltp: q.lastPrice,
    open: q.open,
    high: q.dayHigh,
    low: q.dayLow,
    close: q.previousClose,
    volume: q.volume,
    bid: null,
    ask: null,
    change: q.change,
    changePercent: q.pChange,
    sourceTimestamp: q.timestamp,
    receivedAt,
    latencyMs,
  };
}

export function normalizedToMarketSnapshot(tick: NormalizedFeedTick): MarketSnapshot {
  return {
    symbol: tick.symbol,
    price: tick.ltp,
    ltp: tick.ltp,
    change: tick.change,
    changePercent: tick.changePercent,
    volume: tick.volume,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    prevClose: tick.close,
    timestamp: tick.sourceTimestamp,
  };
}
