// ════════════════════════════════════════════════════════════════
//  getCandles — unified daily-OHLC entry point for the engine
//
//  Upstream: Yahoo Finance only. No other providers are allowed —
//  the architecture is strictly Kite (real-time ticks) + Yahoo
//  (historical bars).
//
//  Never throws. Failure returns `{ ok: false, reason }` so callers
//  (candleIngest's bulk loop) can skip-and-continue without a
//  try/catch at every site.
// ════════════════════════════════════════════════════════════════

import { fetchYahooCandles } from './yahooCandles';
import type { CandleFetchResult } from './yahooCandles';

export type { OhlcBar, CandleFetchResult, CandleSource } from './yahooCandles';

// Permanent skip list — symbols that live in the tradable universe
// but have no Yahoo counterpart. Returning early saves a wasted
// yahoo fetch per candle refresh tick.
const PERMANENT_SKIP = new Set<string>([
  'JUNCTION',
]);

// Negative cache — when Yahoo fails, don't re-probe for 1h. Daily
// bars only update once a day anyway; thrashing a dead symbol every
// minute is pure noise. Cleared on process restart.
const NEGATIVE_TTL_MS = 60 * 60 * 1_000;
const failedAt = new Map<string, number>();

export async function getCandles(symbol: string): Promise<CandleFetchResult> {
  const sym = symbol.trim().toUpperCase();

  if (PERMANENT_SKIP.has(sym)) {
    return { ok: false, source: 'yahoo', reason: 'skip:not_tradable' };
  }

  const negAt = failedAt.get(sym);
  if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) {
    return { ok: false, source: 'yahoo', reason: 'neg_cache:yahoo_recently_failed' };
  }

  const yahoo = await fetchYahooCandles(sym, { range: '1y', interval: '1d' });
  if (yahoo.ok) {
    failedAt.delete(sym);
    return yahoo;
  }

  failedAt.set(sym, Date.now());
  return yahoo;
}
