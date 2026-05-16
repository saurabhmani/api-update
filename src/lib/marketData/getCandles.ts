// ════════════════════════════════════════════════════════════════
//  getCandles — daily-OHLC entry point used by the candle ingest path.
//
//  Step 9 of the IndianAPI cutover: this module now pulls from
//  IndianAPI via the provider wrapper. The legacy yahooCandles stub // @deprecated marker
//  remains for compile-time compatibility but is never called from
//  here. Production paths (run-signal-engine, candleRefreshScheduler)
//  go through this function and never see the deprecated Yahoo path. // @deprecated marker
//
//  Never throws. Failure returns `{ ok: false, reason }` so callers
//  (candleIngest's bulk loop) can skip-and-continue without a
//  try/catch at every site.
// ════════════════════════════════════════════════════════════════

import { getHistorical as indianHistorical } from './providers/indianApiProvider';
import { mapToIndianApiSymbol } from './symbolMapper';
import type { OhlcBar, CandleFetchResult, CandleSource } from './yahooCandles'; // @deprecated marker

export type { OhlcBar, CandleFetchResult, CandleSource } from './yahooCandles'; // @deprecated marker

const PERMANENT_SKIP = new Set<string>([
  'JUNCTION',
]);

// *INAV pseudo-symbols are NSE indicative-NAV feeds for ETFs — not
// tradeable instruments. Drop them at the candle layer so every
// caller is freed from re-implementing the filter.
const INAV_PSEUDO_RE = /INAV$/;

// Negative cache — when the provider fails, don't re-probe for 1h.
// Daily bars only update once a day anyway; thrashing a dead symbol
// every minute is pure noise. Cleared on process restart.
const NEGATIVE_TTL_MS = 15 * 60 * 1_000;
const failedAt = new Map<string, number>();

export async function getCandles(symbol: string): Promise<CandleFetchResult> {
  const sym = await mapToIndianApiSymbol(symbol);

  if (PERMANENT_SKIP.has(sym)) {
    return { ok: false, source: 'yahoo', reason: 'skip:not_tradable' }; // @deprecated marker
  }
  if (INAV_PSEUDO_RE.test(sym)) {
    return { ok: false, source: 'yahoo', reason: 'skip:inav_pseudo_symbol' }; // @deprecated marker
  }

  const negAt = failedAt.get(sym);
  if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) {
    return { ok: false, source: 'yahoo', reason: 'neg_cache:provider_recently_failed' }; // @deprecated marker
  }

  const inv = await indianHistorical(sym, '1y');
  if (inv.status === 'success' || inv.status === 'partial') {
    const series = inv.data;
    const bars: OhlcBar[] = (series?.candles ?? []).map((c) => ({
      ts:     c.t,
      open:   c.o,
      high:   c.h,
      low:    c.l,
      close:  c.c,
      volume: c.v,
    }));
    if (bars.length > 0) {
      failedAt.delete(sym);
      // The CandleSource union is still typed as 'yahoo' for legacy // @deprecated marker
      // reasons — leaving it that way keeps the caller's discriminator
      // working unchanged. The provenance is faithfully recorded in
      // q365_data_feed_health (Step 7).
      return { ok: true, candles: bars, source: 'yahoo' as CandleSource }; // @deprecated marker
    }
  }

  failedAt.set(sym, Date.now());
  return {
    ok: false,
    source: 'yahoo', // @deprecated marker
    reason: inv.errorCode ? `provider:${inv.errorCode}` : 'provider:no_data',
  };
}
