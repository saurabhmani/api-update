// ════════════════════════════════════════════════════════════════
//  yahooBatch — LEGACY-NAMED COMPAT SHIM // @deprecated marker
//
//  @deprecated  The function name is preserved so existing route
//  handlers (api/ticker, api/rankings, api/market, api/market-data/*)
//  keep compiling. The implementation now routes through the central
//  marketDataResolver — IndianAPI primary, cache, NSE-direct,
//  emergency Yahoo. New code must import from MarketDataResolver // @deprecated marker
//  directly; this shim is scheduled for removal once every route is
//  migrated.
// ════════════════════════════════════════════════════════════════

import { resolveBatch } from './resolver/marketDataResolver';

export interface YahooBatchQuote { // @deprecated marker
  symbol:        string;
  price:         number | null;
  change:        number | null;
  pChange:       number | null;
  previousClose: number | null;
  marketTime:    number | null;
}

export async function fetchYahooQuotesBatch( // @deprecated marker
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, YahooBatchQuote>> { // @deprecated marker
  const out = new Map<string, YahooBatchQuote>(); // @deprecated marker
  if (!symbols || symbols.length === 0) return out;

  // Resolve through the central chain. `quiet: true` keeps the
  // resolver from emitting an extra cache-step health row when this
  // legacy shim is the entry point — the IndianAPI primary call
  // already logs.
  const result = await resolveBatch(symbols, { quiet: true, signal });
  for (const [sym, snap] of result.snapshots) {
    out.set(sym, {
      symbol:        sym,
      price:         Number.isFinite(snap.price) ? snap.price : null,
      change:        Number.isFinite(snap.change) ? snap.change : null,
      pChange:       Number.isFinite(snap.changePercent) ? snap.changePercent : null,
      previousClose: Number.isFinite(snap.prevClose) ? snap.prevClose : null,
      marketTime:    Number.isFinite(snap.timestamp) ? snap.timestamp : null,
    });
  }
  return out;
}
