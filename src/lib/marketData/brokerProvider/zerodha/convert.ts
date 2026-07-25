/**
 * Zerodha (Kite) → normalized market-data converters.
 * Callers never see Kite DTOs.
 */

import type { KiteHistoricalCandle, KiteQuote } from '@/lib/kite/types';
import type { Tick } from '@/lib/marketData/kiteTicker';
import { instrumentKeyFromNormalized, toInstrumentKey } from '../instrumentKey';
import type {
  BrokerCandleInterval,
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedQuote,
  NormalizedTick,
} from '../types';

export function kiteIntervalFromBroker(
  interval: BrokerCandleInterval,
): 'minute' | '5minute' | '15minute' | '30minute' | '60minute' | 'day' {
  switch (interval) {
    case '1minute':
      return 'minute';
    case '5minute':
      return '5minute';
    case '15minute':
      return '15minute';
    case '30minute':
      return '30minute';
    case '60minute':
      return '60minute';
    case 'day':
      return 'day';
    case 'week':
    case 'month':
      // Kite day bars; callers aggregate if needed.
      return 'day';
    default:
      return 'day';
  }
}

export function kiteQuoteToNormalized(
  key: string,
  quote: KiteQuote,
): NormalizedQuote {
  const [exchangeRaw, symbolRaw] = key.includes(':')
    ? key.split(':', 2)
    : ['NSE', key];
  const exchange = (exchangeRaw || 'NSE').toUpperCase();
  const symbol = (symbolRaw || '').toUpperCase();
  const close = quote.ohlc?.close ?? null;
  const ltp = Number(quote.last_price) || 0;
  const change =
    typeof quote.net_change === 'number'
      ? quote.net_change
      : close != null
        ? ltp - close
        : null;
  const changePercent =
    change != null && close
      ? (change / close) * 100
      : null;

  let asOfMs = Date.now();
  if (quote.timestamp) {
    const parsed = Date.parse(quote.timestamp);
    if (Number.isFinite(parsed)) asOfMs = parsed;
  }

  return {
    symbol,
    exchange,
    ltp,
    open: quote.ohlc?.open ?? null,
    high: quote.ohlc?.high ?? null,
    low: quote.ohlc?.low ?? null,
    close,
    prevClose: close,
    volume: typeof quote.volume === 'number' ? quote.volume : null,
    change,
    changePercent,
    asOfMs,
    quality: 'live',
  };
}

export function kiteCandleToNormalized(candle: KiteHistoricalCandle): NormalizedCandle {
  const date = candle.date instanceof Date ? candle.date : new Date(candle.date);
  const ts = Number.isFinite(date.getTime())
    ? date.toISOString()
    : String(candle.date);
  return {
    ts,
    open: Number(candle.open) || 0,
    high: Number(candle.high) || 0,
    low: Number(candle.low) || 0,
    close: Number(candle.close) || 0,
    volume: Number(candle.volume) || 0,
  };
}

export function kiteTickToNormalized(input: {
  tick: Tick;
  userId: string;
  exchange?: string;
  symbol?: string;
}): NormalizedTick {
  const symbol = (input.symbol || input.tick.symbol || '').toUpperCase();
  const exchange = (input.exchange || 'NSE').toUpperCase();
  return {
    provider: 'zerodha',
    userId: input.userId,
    instrumentKey: toInstrumentKey(exchange, symbol),
    exchange,
    symbol,
    brokerToken: String(input.tick.token),
    lastPrice: Number(input.tick.lastPrice) || 0,
    open: input.tick.open,
    high: input.tick.high,
    low: input.tick.low,
    close: input.tick.close,
    volume: input.tick.volume,
    receivedAt: new Date(input.tick.ts || Date.now()).toISOString(),
  };
}

export function resolvedInstrumentMeta(inst: NormalizedInstrument): {
  symbol: string;
  exchange: string;
  instrumentKey: string;
} {
  const symbol = String(inst.symbol ?? '').trim().toUpperCase();
  const exchange = String(inst.exchange ?? 'NSE').trim().toUpperCase() || 'NSE';
  const instrumentKey =
    inst.instrumentKey?.trim()
    || instrumentKeyFromNormalized({ ...inst, symbol, exchange });
  return {
    symbol,
    exchange,
    instrumentKey,
  };
}
