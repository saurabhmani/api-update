// ════════════════════════════════════════════════════════════════
//  Kite → canonical `@/types/market` mappers
//
//  UI / engines never see raw Kite payloads — only MarketSnapshot,
//  HistoricalSeries, etc. Keep all field-mapping decisions here.
// ════════════════════════════════════════════════════════════════

import type {
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  MarketSnapshot,
  SymbolSearchHit,
} from '@/types/market';
import type {
  KiteHistoricalCandle,
  KiteInstrument,
  KiteLTP,
  KiteOHLC,
  KiteQuote,
  KiteQuotesMap,
} from '@/lib/kite';
import { normalizeAppSymbol } from './instrumentLookup';

function finite(n: unknown, fallback = 0): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function parseVendorTs(raw: string | null | undefined, fallback = Date.now()): number {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Full Kite quote → MarketSnapshot.
 * `symbol` is the app-level tradingsymbol (RELIANCE), not `NSE:RELIANCE`.
 */
export function mapKiteQuoteToSnapshot(
  symbol: string,
  quote: KiteQuote,
): MarketSnapshot {
  const sym = normalizeAppSymbol(symbol);
  const ltp = finite(quote.last_price);
  const prevClose = finite(quote.ohlc?.close, ltp);
  const change = ltp - prevClose;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const timestamp = parseVendorTs(quote.last_trade_time)
    || parseVendorTs(quote.timestamp)
    || Date.now();

  return {
    symbol: sym,
    price: ltp,
    ltp,
    change,
    changePercent,
    volume: finite(quote.volume),
    open: finite(quote.ohlc?.open),
    high: finite(quote.ohlc?.high),
    low: finite(quote.ohlc?.low),
    prevClose,
    timestamp,
  };
}

/** Batch quotes map → MarketSnapshot[]; keys may be `NSE:SYM` or plain. */
export function mapKiteQuotesToSnapshots(
  quotes: KiteQuotesMap,
  /** Optional requested app symbols — used to label snapshots when Kite keys differ. */
  requestedSymbols?: string[],
): MarketSnapshot[] {
  const wanted = new Set(
    (requestedSymbols ?? []).map(normalizeAppSymbol).filter(Boolean),
  );
  const out: MarketSnapshot[] = [];

  for (const [key, quote] of Object.entries(quotes)) {
    if (!quote) continue;
    const fromKey = normalizeAppSymbol(key);
    const symbol = wanted.has(fromKey)
      ? fromKey
      : (wanted.size === 1 ? [...wanted][0]! : fromKey);
    const snap = mapKiteQuoteToSnapshot(symbol, quote);
    if (snap.price > 0) out.push(snap);
  }
  return out;
}

/** Compact LTP row → minimal MarketSnapshot (OHLC zeroed except prevClose≈ltp). */
export function mapKiteLtpToSnapshot(symbol: string, ltp: KiteLTP): MarketSnapshot {
  const sym = normalizeAppSymbol(symbol);
  const price = finite(ltp.last_price);
  return {
    symbol: sym,
    price,
    ltp: price,
    change: 0,
    changePercent: 0,
    volume: 0,
    open: 0,
    high: 0,
    low: 0,
    prevClose: price,
    timestamp: Date.now(),
  };
}

/** Compact OHLC row → MarketSnapshot. */
export function mapKiteOhlcToSnapshot(symbol: string, row: KiteOHLC): MarketSnapshot {
  const sym = normalizeAppSymbol(symbol);
  const ltp = finite(row.last_price);
  const prevClose = finite(row.ohlc?.close, ltp);
  const change = ltp - prevClose;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  return {
    symbol: sym,
    price: ltp,
    ltp,
    change,
    changePercent,
    volume: 0,
    open: finite(row.ohlc?.open),
    high: finite(row.ohlc?.high),
    low: finite(row.ohlc?.low),
    prevClose,
    timestamp: Date.now(),
  };
}

export function mapKiteCandle(candle: KiteHistoricalCandle): HistoricalCandle {
  const t = candle.date instanceof Date
    ? candle.date.getTime()
    : Date.parse(String(candle.date));
  return {
    t: Number.isFinite(t) ? t : 0,
    o: finite(candle.open),
    h: finite(candle.high),
    l: finite(candle.low),
    c: finite(candle.close),
    v: finite(candle.volume),
  };
}

export function mapKiteHistoricalToSeries(
  symbol: string,
  range: HistoricalRange,
  candles: KiteHistoricalCandle[],
): HistoricalSeries {
  return {
    symbol: normalizeAppSymbol(symbol),
    range,
    candles: (candles ?? [])
      .map(mapKiteCandle)
      .filter((c) => c.t > 0)
      .sort((a, b) => a.t - b.t),
  };
}

export function mapKiteInstrumentToSearchHit(inst: KiteInstrument): SymbolSearchHit {
  return {
    symbol: String(inst.tradingsymbol ?? '').trim().toUpperCase(),
    name: String(inst.name ?? inst.tradingsymbol ?? '').trim(),
    exchange: String(inst.exchange ?? '').trim().toUpperCase() || undefined,
    type: String(inst.instrument_type ?? '').trim() || undefined,
  };
}

/** Extract LTP number from a Kite quote (for getLTP helpers). */
export function mapKiteQuoteToLtp(quote: KiteQuote | KiteLTP): number {
  return finite(quote.last_price);
}

/** Extract OHLC block from a quote or compact OHLC row. */
export function mapKiteQuoteToOhlc(quote: KiteQuote | KiteOHLC): {
  open: number;
  high: number;
  low: number;
  close: number;
  last_price: number;
} {
  return {
    open: finite(quote.ohlc?.open),
    high: finite(quote.ohlc?.high),
    low: finite(quote.ohlc?.low),
    close: finite(quote.ohlc?.close),
    last_price: finite(quote.last_price),
  };
}
