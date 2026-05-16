// ════════════════════════════════════════════════════════════════
//  streamSignalsCache — module-level SWR cache for /api/signals/stream
//
//  Why this lives here, not in stream/route.ts:
//    Next.js Route Handlers may only export a fixed set of names
//    (HTTP methods + dynamic / revalidate / etc.). Exporting
//    `invalidateStreamSignalsCache` from stream/route.ts trips the
//    `.next/types` validator with TS2344. Moving the state + the
//    invalidator into a shared module keeps the route file
//    compliant while preserving the cache semantics other paths
//    rely on (the scanner and signal-engine endpoints both call
//    `invalidateStreamSignalsCache()` after writing a new batch).
//
//  Behaviour is byte-identical to the previous inline implementation:
//    - 4s "fresh" window (`SIGNALS_CACHE_FRESH_MS`).
//    - 6s cold-fetch timeout (`SIGNALS_FETCH_TIMEOUT_MS`).
//    - Single-flight background refresh while serving stale.
//    - Timeout fallbacks are NOT cached (so a flaky fetch doesn't
//      pin an empty array for 4s).
// ════════════════════════════════════════════════════════════════

const SIGNALS_CACHE_FRESH_MS   = 4_000;
const SIGNALS_FETCH_TIMEOUT_MS = 6_000;

let signalsCache: { ts: number; data: unknown[] } | null = null;
let signalsRefreshing = false;

export interface StreamCacheResult<T> {
  data:     T[];
  verified: boolean;
  source:   'fresh' | 'cached' | 'cached-stale' | 'cold-fallback';
}

/** Reset the cache. Called from /api/run-signal-engine and the
 *  custom-universe scanner after a new batch is committed and prior
 *  rows are expired — without this, the stream keeps pushing its
 *  4s-fresh / unbounded-stale snapshot for several seconds,
 *  overwriting the dashboard's correct TOTAL with the pre-expire
 *  count. */
export function invalidateStreamSignalsCache(): void {
  signalsCache = null;
}

/** Tagged timeout wrapper. Returns ok=false when the timeout fires
 *  so the caller knows not to commit the empty fallback into cache. */
function withTimeoutTagged<T>(
  p:        Promise<T>,
  ms:       number,
  fallback: T,
): Promise<{ data: T; ok: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<{ data: T; ok: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ data: fallback, ok: false }), ms);
  });
  const real = p
    .then((data) => ({ data, ok: true as const }))
    .catch(() => ({ data: fallback, ok: false as const }));
  return Promise.race([real, timeoutP]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<{ data: T; ok: boolean }>;
}

/**
 * SWR wrapper around the SSE data fetcher.
 *
 * Contract (matches the previous inline `getActiveSignalsCached` /
 * `getConfirmedSnapshotsCached` helper byte-for-byte):
 *   - Warm + fresh   (cache age < 4s)  → return cached, source='cached', no fetch.
 *   - Warm + stale   (cache exists)    → return cached + kick a single-flight
 *                                        background refresh. source='cached-stale'.
 *   - Cold           (no cache)        → wait up to 6s for fetcher; commit
 *                                        only ok results. source='fresh' or
 *                                        'cold-fallback' if the timeout fired.
 */
export async function getCachedOrFetch<T>(
  fetcher: () => Promise<T[]>,
): Promise<StreamCacheResult<T>> {
  const now = Date.now();

  if (signalsCache && now - signalsCache.ts < SIGNALS_CACHE_FRESH_MS) {
    return { data: signalsCache.data as T[], verified: true, source: 'cached' };
  }

  if (signalsCache) {
    if (!signalsRefreshing) {
      signalsRefreshing = true;
      fetcher()
        .then((data) => { signalsCache = { ts: Date.now(), data: data as unknown[] }; })
        .catch((err) => console.warn('[streamSignalsCache] background refresh failed:', (err as any)?.message))
        .finally(() => { signalsRefreshing = false; });
    }
    return { data: signalsCache.data as T[], verified: true, source: 'cached-stale' };
  }

  const { data, ok } = await withTimeoutTagged(
    fetcher(),
    SIGNALS_FETCH_TIMEOUT_MS,
    [] as T[],
  );
  if (ok) {
    signalsCache = { ts: Date.now(), data: data as unknown[] };
  }
  return { data, verified: ok, source: ok ? 'fresh' : 'cold-fallback' };
}
