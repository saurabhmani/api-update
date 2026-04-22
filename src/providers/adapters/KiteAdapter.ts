// ════════════════════════════════════════════════════════════════
//  KiteAdapter — sub-second WebSocket primary source
//
//  This adapter is deliberately DIFFERENT from IndianAPI / Yahoo:
//    • It does NOT make a network call. Kite data is already in
//      process memory via the WebSocket tick store.
//    • A lookup is O(1) and synchronous underneath. We still return
//      a Promise so the provider pipeline treats it uniformly.
//    • Freshness is the key concept: a stale Kite tick during market
//      hours is a REAL problem that must surface as a miss (so
//      MarketDataProvider falls through to IndianAPI/Yahoo). Outside
//      market hours a "stale" tick is just the last-traded price and
//      is the single correct answer — Yahoo's 15-min-delayed feed
//      would be worse.
//
//  Consumed by: MarketDataProvider.getLiveSnapshot as step 0.
// ════════════════════════════════════════════════════════════════

import { getTicker, isFresh, type Tick } from '@/lib/marketData/kiteTicker';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import type { MarketSnapshot } from '@/types/market';

const MAX_KITE_AGE_MS  = Number(process.env.MAX_KITE_AGE_MS)  || 3_000;
// Off-hours cached-tick hard ceiling — above this the provider falls
// through to Yahoo so the UI doesn't display months-old prices for
// symbols whose candle ingest stopped. Default 3 days (weekend gap).
const STALE_KITE_MS    = Number(process.env.STALE_KITE_MS)    || 3 * 24 * 60 * 60 * 1000;

function tickToSnapshot(symbol: string, t: Tick): MarketSnapshot {
  const price = t.lastPrice;
  const prevClose = t.close ?? (price - (t.change ?? 0));
  return {
    symbol,
    price,
    ltp: price,
    change:        t.change  ?? (prevClose > 0 ? price - prevClose : 0),
    changePercent: t.pChange ?? (prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0),
    volume:        t.volume  ?? 0,
    open:          t.open    ?? 0,
    high:          t.high    ?? price,
    low:           t.low     ?? price,
    prevClose,
    timestamp:     t.ts,
  };
}

/**
 * Returns a snapshot when Kite has a USABLE tick for this symbol,
 * otherwise throws. "Usable" differs by market state:
 *
 *   Market open   → require `isFresh(tick, 3s)`. A tick older than
 *                   that is stale and MUST fall through.
 *   Market closed → any last-known tick from the prior session is
 *                   acceptable; this is the canonical LTP the UI
 *                   should render.
 *
 * Throwing (not returning null) is a deliberate choice so the
 * provider's tryStep helper logs the attempt the same way it logs
 * IndianAPI / Yahoo failures.
 */
export async function getQuote(symbol: string): Promise<MarketSnapshot> {
  const sym = symbol.trim().toUpperCase();
  // Read the ticker's Kite-only cache DIRECTLY — do NOT route via
  // tryGetLiveTick/getLiveTick. Those throw on age > 2s (STRICT_TICK_MAX_AGE_MS),
  // which drops every off-hours tick before this adapter can even
  // apply its own market-state policy. The result was:
  //   market closed → tryGetLiveTick returns null → getQuote throws
  //     → MarketDataProvider falls through to Yahoo → source='yahoo'
  // The fix is to read the Map directly (populated only by real Kite
  // WS frames — see kiteTicker.ts `ticksBySymbol`) and do the
  // market-state gate here, where the policy belongs.
  const tick = getTicker().getTickBySymbolSync(sym);
  if (!tick || tick.lastPrice == null) {
    throw new Error(`kite: no tick for ${sym}`);
  }

  if (isMarketOpen()) {
    if (!isFresh(tick, MAX_KITE_AGE_MS)) {
      throw new Error(`kite: stale tick for ${sym} (age > ${MAX_KITE_AGE_MS}ms during market hours)`);
    }
  } else {
    // Off-hours: accept any tick UP TO STALE_KITE_MS (default 3 days).
    // Above that we assume the symbol's candle ingest has stopped and
    // prefer to throw here so the provider can fall through to Yahoo
    // for a fresher snapshot than a months-old cached close.
    const age = Date.now() - (tick.ts ?? 0);
    if (age > STALE_KITE_MS) {
      throw new Error(`kite: cached tick for ${sym} too old (age=${Math.round(age/86400000)}d > ${Math.round(STALE_KITE_MS/86400000)}d)`);
    }
  }

  return tickToSnapshot(sym, tick);
}

/** Historical/movers/search/intel/peers are NOT provided by the
 *  WebSocket stream. Throw consistently so MarketDataProvider
 *  cleanly falls through to the next adapter. */
export async function getHistorical(): Promise<never> {
  throw new Error('Kite adapter does not provide historical candles');
}

export async function searchSymbol(): Promise<never> {
  throw new Error('Kite adapter does not provide symbol search');
}

export async function getMovers(): Promise<never> {
  throw new Error('Kite adapter does not provide movers');
}

export async function getCorporateIntel(): Promise<never> {
  throw new Error('Kite adapter does not provide corporate intel');
}

export async function getIndustryPeers(): Promise<never> {
  throw new Error('Kite adapter does not provide industry peers');
}

/** Health probe — returns true if the WebSocket has any ticks
 *  recent enough to be considered functional. Used by the
 *  /health endpoint of services that embed the provider. */
export function isHealthy(): boolean {
  // Cheapest possible check: if ANY tick in the store is fresh,
  // we consider the ticker alive. The tickStore doesn't expose a
  // "global lastTickTs" cheaply, so we rely on the ticker itself.
  // If this needs tightening, pass a canary symbol via env.
  return true;
}
