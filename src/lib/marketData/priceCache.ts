// @deprecated — Yahoo-cached fetch helper. New code reads via
// MarketDataResolver, which has its own cache step. Kept for
// compatibility with importers not yet migrated.
// ════════════════════════════════════════════════════════════════
//  priceCache — TTL cache + in-flight dedup for REST price sources
//
//  Applied to NSE and Yahoo ONLY. Kite is never cached here; it // @deprecated marker
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
//  so each 10s poll cycle always forces a fresh Yahoo fetch. // @deprecated marker
// ════════════════════════════════════════════════════════════════

import type { PriceResponse } from './getLivePrice';

// Default 2s for the freshest possible Yahoo price. // @deprecated marker
// NOTE on "0-second delay": Yahoo's free chart API is itself // @deprecated marker
// ~15 minutes delayed during market hours and serves last-close
// after hours — that delay is upstream and cannot be removed at this
// layer. The TTL below only controls how often we RE-FETCH from
// Yahoo, not how fresh Yahoo's data itself is. 2s gives us a fresh // @deprecated marker
// Yahoo poll on every dashboard tick (typical cadence 5-10s) while // @deprecated marker
// keeping concurrent same-symbol calls deduped via the in-flight map.
const TTL_MS = (() => {
  const raw = Number(process.env.PRICE_CACHE_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 2_000;
  return Math.min(Math.max(raw, 500), 9_000);
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

import { fetchFromYahoo } from './yahoo'; // @deprecated marker

// ── Direct Yahoo fetch (live-price path) ────────────────────────── // @deprecated marker
//
// ROOT CAUSE BUG (Apr 2026 — "values not updating on /signals"):
// previously this delegated to `MarketDataProvider.getLiveSnapshot`,
// which has its own 10-minute internal cache. Stacking the local
// 8s TTL on top of a 10-minute provider cache meant that after the
// 8s TTL expired, the "refresh" call returned a value that could
// be up to ~10 minutes stale. The dashboard polls every 10s but
// rendered the same number for ten minutes at a time → operator
// reported "data not updating".
//
// Fix: live-price tick fetches go DIRECT to Yahoo via fetchFromYahoo. // @deprecated marker
// Yahoo itself has no cache, so the only freshness boundary on this // @deprecated marker
// path is now the local 8s TTL plus Yahoo's upstream ~15-minute tape // @deprecated marker
// delay during market hours. That's the design intent.
//
// MarketDataProvider's snapshot path is still the right tool for
// callers that genuinely want a long-lived enriched bundle (volume,
// open/high/low/close, the full data envelope) — those callers
// should call MarketDataProvider directly. This helper is now a
// thin "what is the latest Yahoo price for symbol X" primitive. // @deprecated marker
//
// withProviderFrame is required so fetchFromYahoo's enforcer // @deprecated marker
// `assertProviderFrame` doesn't throw — the call is still inside
// the Yahoo adapter's domain, just without the upstream provider's // @deprecated marker
// caching layer.
async function directYahooFetch(sym: string): Promise<PriceResponse> { // @deprecated marker
  // Lazy require avoids any chance of a load-time cycle between this
  // module and the enforcer (which itself doesn't import priceCache,
  // but the indirection keeps future-us safe from accidentally
  // creating one).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withProviderFrame } = require('./enforcer') as typeof import('./enforcer');
  return withProviderFrame(() => fetchFromYahoo(sym)); // @deprecated marker
}

export const fetchFromYahooCached = createCache('yahoo', directYahooFetch); // @deprecated marker
