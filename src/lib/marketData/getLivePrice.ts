// ════════════════════════════════════════════════════════════════
//  getLivePrice — Kite primary, Yahoo ALWAYS-available fallback
//
//  Data flow (STRICT, no activation gates, no policy blocks):
//
//    Layer 1  — Kite in-memory tick cache (O(1))
//               Served only when the ticker is 'open' AND a tick
//               for the symbol exists in cache AND its age meets
//               MAX_KITE_AGE_MS (market-open path) / STALE_KITE_MS
//               (market-closed path).
//
//    Layer 2  — Kite EOD close from market_data_daily VIEW
//               Projected candles from the Kite ingest pipeline.
//               Useful off-hours when the WS isn't producing ticks
//               but we still have an authoritative last close.
//
//    Layer 3  — Yahoo Finance (UNCONDITIONAL fallback)
//               Always tried if Layer 1+2 missed. No loginRequired
//               gate, no "market-open disables Yahoo" policy, no
//               wait-for-poller-to-activate dance. Yahoo answers or
//               it doesn't — that's the only question.
//
//  If all three miss → { price: null, source: 'none', error }
//
//  This contract is the load-bearing guarantee downstream systems
//  rely on: the signal engine's rescore loop, the UI's live-price
//  badge, the news engine's impact scoring — all need "some price,
//  even if delayed" far more than they need "real-time or bust".
// ════════════════════════════════════════════════════════════════

import { getTicker, isFresh } from './kiteTicker';
import { fetchFromYahoo } from './yahoo';
import { withProviderFrame } from './enforcer';
import { isMarketOpen } from './marketHours';
import { logger } from '@/lib/logger';
import { formatSymbol } from './formatSymbol';
import {
  isYahooAvailable,
  recordYahooSuccess,
  recordYahooFailure,
} from './yahooCircuitBreaker';

const log = logger.child({ component: 'getLivePrice' });

export type PriceSource = 'kite' | 'yahoo' | 'none';

export type PriceResponse = {
  price:   number | null;
  change?: number;
  pChange?: number;
  volume?: number;
  open?:   number;
  high?:   number;
  low?:    number;
  close?:  number;
  ageMs?:  number;
  source:  PriceSource;
  /** True when the tick is from Kite but older than the live-freshness
   *  threshold — e.g. market closed, last trade was Friday. UI should
   *  render a "(last traded)" badge rather than a live heartbeat. */
  stale?:  boolean;
  error?:  string;
};

// Freshness threshold for "Kite is active" on a specific symbol.
// 3s is the default — tight enough to reject stale data during an
// outage, loose enough to tolerate quiet names that tick every
// couple of seconds. Tune via MAX_KITE_AGE_MS env (1000-10000).
const MAX_KITE_AGE_MS =
  Number(process.env.MAX_KITE_AGE_MS) || 3_000;

// Max age of a cached Kite tick or EOD bar before we consider it
// "too old to show" and fall through to Yahoo. Default: 3 days
// (covers a normal weekend gap). When the candle ingest pipeline
// hasn't run for a symbol in a while, its MAX(ts) in candles may
// be months/years old — blindly rendering that as "last close"
// would display nonsense prices. Above this threshold we prefer a
// 15-min-delayed Yahoo snapshot over a years-old Kite close.
const STALE_KITE_MS =
  Number(process.env.STALE_KITE_MS) || 3 * 24 * 60 * 60 * 1000;

/**
 * Returns true only if the WebSocket is open AND a fresh tick
 * exists in the in-memory cache for the given symbol. This is
 * the single predicate that gates whether fallback runs.
 */
export function isKiteActive(symbol: string): boolean {
  const ticker = getTicker();
  if (ticker.getStatus().state !== 'open') return false;
  // Single source of truth for freshness — `isFresh` reads the
  // same MAX_KITE_AGE_MS env var this file references above.
  return isFresh(ticker.getTickBySymbolSync(symbol), MAX_KITE_AGE_MS);
}

/**
 * The single public entry point for live prices. Strict priority:
 *
 *   1. Kite in-memory cache (any age when market closed; ≤ MAX_KITE_AGE_MS
 *      when market open). This is a fully synchronous O(1) read off the
 *      ticker's `ticksBySymbol` Map — only populated by real Kite WS
 *      frames, never by Yahoo.
 *   2. Kite EOD close from `market_data_daily` VIEW (Kite-sourced candles
 *      projected under the legacy shape). Only queried when the in-memory
 *      cache has nothing — typical on a fresh process start during closed
 *      hours.
 *   3. MarketDataProvider chain (IndianAPI → cache → Yahoo → DB). Only
 *      consulted when market is OPEN and layers 1–2 missed. Off-hours
 *      the function returns source='none' instead of falling through to
 *      Yahoo — per spec, Yahoo must never be the answer after close.
 *
 * The return shape is deliberately the same across all three
 * sources so callers never need to branch on `source`.
 */
export async function getLivePrice(symbol: string): Promise<PriceResponse> {
  if (!symbol || typeof symbol !== 'string') {
    return { price: null, source: 'none', error: 'symbol required' };
  }
  // Single point of normalisation — formatSymbol strips "NSE:" /
  // ".NS" suffixes, uppercases, and returns the bare ticker. Every
  // downstream layer (Kite cache, EOD query, Yahoo) expects the
  // bare form; ad-hoc trim()/toUpperCase() lived in multiple places
  // before and let "NSE:RELIANCE" slip through to Kite EOD lookups
  // where the row is keyed on "RELIANCE".
  const sym = formatSymbol(symbol).raw;
  if (!sym) {
    return { price: null, source: 'none', error: 'symbol invalid' };
  }
  const marketOpen = isMarketOpen();

  console.log(`[PRICE FETCH] ${sym}`);

  // ── Layer 1: Kite in-memory cache ───────────────────────────────
  // getTickBySymbolSync reads the ticker's Kite-only Map directly
  // (see kiteTicker.ts — ticksBySymbol is populated ONLY by the
  // 'ticks' bridge in the KiteTicker constructor). No age gate
  // here — a stale Kite tick is the authoritative last-traded
  // price outside market hours. During hours we DO apply a
  // freshness gate so an hour-old tick falls through and we
  // hit the provider chain.
  const ticker = getTicker();
  const tick = ticker.getTickBySymbolSync(sym);
  if (tick && tick.lastPrice != null && tick.lastPrice > 0) {
    const age = Date.now() - tick.ts;
    // Market OPEN  → require ≤3s freshness (real-time).
    // Market CLOSED → allow any age UP TO STALE_KITE_MS (3 days default).
    //                  Older than that is likely a symbol whose candle
    //                  ingest stopped — don't show months-old prices,
    //                  fall through to Yahoo for a fresher snapshot.
    const acceptable = marketOpen
      ? isFresh(tick, MAX_KITE_AGE_MS)
      : age < STALE_KITE_MS;
    if (acceptable) {
      console.log(`[KITE SUCCESS] ${sym} price=${tick.lastPrice} age=${age}ms`);
      return {
        price:   tick.lastPrice,
        change:  tick.change,
        pChange: tick.pChange,
        volume:  tick.volume,
        open:    tick.open,
        high:    tick.high,
        low:     tick.low,
        close:   tick.close,
        ageMs:   age,
        source:  'kite',
        // Label as stale ONLY during market hours when the tick exceeds
        // the freshness threshold. Off-hours "staleness" is expected
        // and the UI should render it as "last traded" without warning.
        stale:   marketOpen && age > MAX_KITE_AGE_MS,
      };
    }
  }
  console.log(`[KITE FAIL] ${sym} (no fresh tick in cache)`);

  // ── Layer 2: Kite EOD close from market_data_daily VIEW ─────────
  // Only queried when the in-memory cache has nothing OR (market-open
  // path) the cache is stale. The VIEW projects `candles` rows with
  // candle_type='eod' AND interval_unit='1day', i.e. authoritative
  // Kite closes recorded by the candle ingest pipeline.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { db } = await import('@/lib/db');
    const { rows } = await db.query<{
      ts: Date | string | number;
      close: number | string;
      prev_close: number | string | null;
    }>(
      `SELECT t.ts, t.close,
         (SELECT close FROM market_data_daily
           WHERE symbol = t.symbol AND ts < t.ts
           ORDER BY ts DESC LIMIT 1) AS prev_close
       FROM market_data_daily t
       WHERE t.symbol = ?
       ORDER BY t.ts DESC
       LIMIT 1`,
      [sym],
    );
    const r = (rows as any[])[0];
    if (r) {
      const close = Number(r.close);
      if (Number.isFinite(close) && close > 0) {
        const prev = r.prev_close != null ? Number(r.prev_close) : null;
        const pChange =
          prev != null && Number.isFinite(prev) && prev > 0
            ? ((close - prev) / prev) * 100
            : 0;
        const change = prev != null && Number.isFinite(prev) ? close - prev : 0;
        const tsMs =
          r.ts instanceof Date
            ? r.ts.getTime()
            : typeof r.ts === 'number'
              ? r.ts
              : new Date(r.ts as string).getTime();
        const age = Date.now() - (Number.isFinite(tsMs) ? tsMs : Date.now());
        // Age gate: reject EOD rows that are themselves ancient — a
        // symbol whose last candle is months old would otherwise pin
        // the UI to a bogus "last close" forever. Above STALE_KITE_MS
        // fall through to Yahoo for a fresher snapshot.
        if (age > STALE_KITE_MS) {
          console.log(
            `[DATA] KITE_EOD_TOO_OLD ${sym} close=${close} ` +
            `age=${Math.round(age / 86400000)}d → falling to Yahoo`,
          );
        } else {
          console.log(
            `[DATA] KITE_EOD_HIT ${sym} close=${close} ` +
            `age=${Math.round(age / 86400000)}d market=${marketOpen ? 'OPEN' : 'CLOSED'}`,
          );
          return {
            price:   close,
            change,
            pChange,
            close:   prev ?? undefined,
            ageMs:   age,
            source:  'kite', // Kite-sourced EOD from candles
            stale:   true,
          };
        }
      }
    }
  } catch (err) {
    log.warn('getLivePrice EOD lookup failed', {
      symbol: sym, error: (err as Error).message,
    });
  }

  // ── Layer 3: Yahoo (UNCONDITIONAL fallback, circuit-breaker gated) ──
  //
  // Any symbol that missed Kite cache AND Kite EOD gets a direct
  // Yahoo lookup. No activation flag, no loginRequired check, no
  // market-open policy. If Yahoo answers, the caller gets a price.
  //
  // The ONE protective gate: yahooCircuitBreaker. After 20 consecutive
  // Yahoo failures the breaker trips OPEN for 5 minutes — callers
  // short-circuit to "no data" during the pause. This prevents a
  // 2700-symbol rescore cycle from spamming Yahoo into an IP ban
  // when the upstream is rate-limiting us or down.
  //
  // withProviderFrame is required because yahoo.ts has a tripwire
  // (enforcer) that rejects unframed callers in staging/prod.
  if (!isYahooAvailable()) {
    console.log(`[YAHOO FAIL] ${sym} breaker=OPEN (paused to prevent IP ban)`);
    return { price: null, source: 'none', error: 'yahoo_breaker_open' };
  }

  try {
    const yahoo = await withProviderFrame(() => fetchFromYahoo(sym));
    if (yahoo && yahoo.price != null && yahoo.price > 0) {
      recordYahooSuccess();
      console.log(`[YAHOO SUCCESS] ${sym} price=${yahoo.price}`);
      log.debug('Yahoo served', { symbol: sym, price: yahoo.price });
      return {
        ...yahoo,
        source: 'yahoo',
      };
    }
    // Null/zero price is a soft failure — probably delisted or
    // Yahoo just doesn't know this ticker. Count it as a failure
    // so a systematic Yahoo outage trips the breaker, but the
    // individual symbol returns cleanly.
    recordYahooFailure('null_or_zero_price');
    console.log(`[YAHOO FAIL] ${sym} (null/zero price)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordYahooFailure(message);
    console.log(`[YAHOO FAIL] ${sym} error=${message}`);
    log.warn('Yahoo fetch failed', { symbol: sym, error: message });
  }

  // ── All three layers missed ────────────────────────────────────
  console.log(`[PRICE FETCH] ${sym} NO_DATA (all sources failed)`);
  return { price: null, source: 'none', error: 'price_unavailable' };
}
