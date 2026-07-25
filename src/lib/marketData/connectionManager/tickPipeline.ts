/**
 * Shared post-normalize tick pipeline for both brokers:
 *   NormalizedTick → keyed liveFeedState → process tickBus broadcast
 */

import { tickBus } from '@/lib/marketData/tickBus';
import { recordLiveFeedTick } from '@/lib/marketData/liveFeedState';
import { MARKET_TICK_EVENT, type MarketStreamTick } from '@/lib/marketData/marketStreamTypes';
import type { NormalizedTick } from '@/lib/marketData/brokerProvider/types';
import type { NormalizedTickBus } from '@/lib/marketData/brokerProvider/tickBus';
import type { Tick } from '@/lib/marketData/kiteTicker';

export function normalizedTickToMarketStream(tick: NormalizedTick): MarketStreamTick {
  const close = tick.close ?? null;
  const change =
    close != null && Number.isFinite(close) ? tick.lastPrice - close : null;
  const pChange =
    change != null && close ? (change / close) * 100 : null;
  return {
    symbol: tick.symbol,
    price: tick.lastPrice,
    change,
    pChange,
    open: tick.open ?? null,
    high: tick.high ?? null,
    low: tick.low ?? null,
    close,
    volume: tick.volume ?? null,
    bid: tick.bid ?? null,
    ask: tick.ask ?? null,
    source: tick.provider,
    ts: Date.parse(tick.receivedAt) || Date.now(),
  };
}

export function normalizedTickToLegacyTick(tick: NormalizedTick): Tick {
  return {
    token: Number(tick.brokerToken) || 0,
    symbol: tick.symbol,
    lastPrice: tick.lastPrice,
    volume: tick.volume,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    ts: Date.parse(tick.receivedAt) || Date.now(),
    // Preserve broker identity — never remap Shoonya→yahoo or Zerodha→kite.
    source: tick.provider,
  };
}

/**
 * Fan-out a normalized tick to THIS user+provider's liveFeedState + buses.
 * Never updates another user's / provider's freshness.
 */
export function publishNormalizedLiveTick(
  tick: NormalizedTick,
  providerBus?: NormalizedTickBus,
): void {
  const receivedAt = Date.now();
  const marketAt = tick.exchangeTimestamp
    ? Date.parse(tick.exchangeTimestamp)
    : undefined;
  recordLiveFeedTick(
    receivedAt,
    marketAt != null && Number.isFinite(marketAt) ? marketAt : undefined,
    { userId: String(tick.userId), provider: tick.provider },
  );

  providerBus?.emit(tick);

  const streamTick = normalizedTickToMarketStream(tick);
  tickBus.emit(MARKET_TICK_EVENT, streamTick);
  tickBus.emit('tick', normalizedTickToLegacyTick(tick));
}
