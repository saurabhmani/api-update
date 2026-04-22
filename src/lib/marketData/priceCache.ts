// ════════════════════════════════════════════════════════════════
//  priceCache — TTL cache + in-flight dedup for REST price sources
//
//  Applied to NSE and Yahoo ONLY. Kite is never cached here; it
//  already serves from an in-memory WebSocket tick map, and adding
//  a TTL on top would make real-time data stale.
//
//  Two layers:
//    1. Result cache  — { value, expiresAt } keyed by symbol.
//                       Hits skip the upstream fetch entirely.
//    2. In-flight map — Map<symbol, Promise<PriceResponse>>.
//                       Concurrent callers for the same symbol
//                       share a single in-progress fetch instead
//                       of stampeding the upstream.
//
//  TTL default: 2s (tunable via PRICE_CACHE_TTL_MS, clamped 1-9s).
//  Set PRICE_CACHE_TTL_MS=9000 when using YAHOO_FALLBACK_POLL_MS=10000
//  so each 10s poll cycle always forces a fresh Yahoo fetch.
// ════════════════════════════════════════════════════════════════

import type { PriceResponse } from './getLivePrice';

const TTL_MS = (() => {
  const raw = Number(process.env.PRICE_CACHE_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 2_000;
  return Math.min(Math.max(raw, 1_000), 9_000);
})();

type Entry = { value: PriceResponse; expiresAt: number };

function createCache(label: string, fetcher: (sym: string) => Promise<PriceResponse>) {
  const results  = new Map<string, Entry>();
  const inflight = new Map<string, Promise<PriceResponse>>();

  return async function cachedFetch(symbol: string): Promise<PriceResponse> {
    const key = symbol.trim().toUpperCase();
    const now = Date.now();

    const hit = results.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = fetcher(key)
      .then((res) => {
        if (res.price != null) {
          results.set(key, { value: res, expiresAt: Date.now() + TTL_MS });
        }
        return res;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  };
}

import { fetchFromYahoo } from './yahoo';

// ── Provider-routed cached fetch ───────────────────────────────────
//
// Historically this was a thin TTL wrapper directly over
// `fetchFromYahoo`. Post-Phase-2 it delegates to MarketDataProvider
// so the full chain (Kite → IndianAPI → provider-cache → Yahoo → DB)
// runs, and the legacy callers that still import this helper get
// the unified data path for free. The PriceResponse shape is
// preserved exactly — no caller needs touching.
//
// We keep a LOCAL TTL cache on top of the provider because the
// provider's own cache has a 10-minute TTL (intentional — snapshots
// don't expire that fast). Some legacy REST consumers here want a
// sub-second retry to be cheap. Hence the 2s inner cache.
async function providerBackedFetch(sym: string): Promise<PriceResponse> {
  // Lazy require avoids a circular import: MarketDataProvider's
  // Yahoo adapter calls fetchFromYahoo (which imports from yahoo.ts,
  // which is fine), but if priceCache ever ended up in the provider
  // module graph at load time, a direct ESM import here could
  // deadlock the type graph.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: MarketDataProvider } = require('@/providers/MarketDataProvider') as
    typeof import('@/providers/MarketDataProvider');
  try {
    const resp = await MarketDataProvider.getLiveSnapshot(sym);
    const s = resp.source;
    // Map provider source → legacy PriceResponse.source. Only two
    // values are representable in PriceSource ('kite' | 'yahoo' |
    // 'none'); 'indian' and 'cache' collapse to 'kite' (live-ish)
    // while 'db' collapses to 'none' (we shouldn't lie about
    // freshness — callers that display a source badge deserve
    // honesty even at the cost of a white "unknown").
    const mappedSource: PriceResponse['source'] =
      s === 'kite' || s === 'indian' ? 'kite' :
      s === 'yahoo' || s === 'cache' ? 'yahoo' :
      'none';
    return {
      price:   resp.data.price,
      change:  resp.data.change,
      pChange: resp.data.changePercent,
      volume:  resp.data.volume,
      open:    resp.data.open,
      high:    resp.data.high,
      low:     resp.data.low,
      close:   resp.data.prevClose,
      source:  mappedSource,
    };
  } catch (err) {
    // Last-resort: go direct to the raw Yahoo fetcher so this
    // helper never returns absent data when Yahoo itself is up. The
    // call is still inside the Yahoo adapter's domain so we wrap it
    // in a provider frame to satisfy the enforcer.
    const { withProviderFrame } = require('./enforcer') as typeof import('./enforcer');
    return withProviderFrame(() => fetchFromYahoo(sym));
  }
}

export const fetchFromYahooCached = createCache('yahoo', providerBackedFetch);
