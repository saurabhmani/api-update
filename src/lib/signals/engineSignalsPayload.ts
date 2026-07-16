// ════════════════════════════════════════════════════════════════
//  Short-TTL cache for nested /api/signals payloads used by
//  daily-report + backtest preview under the 8s parent budget.
//
//  Dashboard / engine-health call both engines in parallel; without
//  this cache each route independently waits up to 12s on
//  /api/signals and the parent aborts at 8s.
// ════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { internalFetch, type InternalFetchResult } from '@/lib/api/internalFetch';
import type { ApiPerfTracker } from '@/lib/api/apiPerf';

/** Nested signals fetch must leave headroom for candles/movers/report. */
export const ENGINE_SIGNALS_FETCH_TIMEOUT_MS = 4_000;

/** Share concurrent parent calls (dashboard fires daily-report + backtest together). */
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  at:       number;
  cookie:   string;
  result:   InternalFetchResult<any>;
}

let cache: CacheEntry | null = null;
let inflight: Promise<InternalFetchResult<any>> | null = null;
let inflightCookie = '';

function cacheKey(cookieHeader: string): string {
  // Cookie is the session boundary; avoid sharing across users.
  return cookieHeader.slice(0, 120);
}

export async function fetchEngineSignalsPayload(
  req: NextRequest,
  cookieHeader: string,
  perf?: ApiPerfTracker,
  requestIdPrefix = 'engine',
): Promise<InternalFetchResult<any>> {
  const key = cacheKey(cookieHeader);
  const now = Date.now();

  if (cache && cache.cookie === key && now - cache.at < CACHE_TTL_MS) {
    perf?.setMeta('signalsPayloadCache', 'hit');
    perf?.mark('signals_payload_cache_hit', { ageMs: now - cache.at });
    return cache.result;
  }

  let cacheMode: 'miss' | 'coalesce' = 'miss';
  if (!inflight || inflightCookie !== key) {
    inflightCookie = key;
    inflight = (async () => {
      const result = await internalFetch<any>(
        req,
        `/api/signals?action=all&limit=20&request_id=${requestIdPrefix}-${Date.now()}`,
        { cookieHeader, timeoutMs: ENGINE_SIGNALS_FETCH_TIMEOUT_MS },
      );
      cache = { at: Date.now(), cookie: key, result };
      return result;
    })().finally(() => {
      if (inflightCookie === key) {
        inflight = null;
        inflightCookie = '';
      }
    });
  } else {
    cacheMode = 'coalesce';
  }

  perf?.setMeta('signalsPayloadCache', cacheMode);

  if (perf) {
    return perf.time('internalFetch.signals', () => inflight!, {
      timeoutMs: ENGINE_SIGNALS_FETCH_TIMEOUT_MS,
      cacheMode,
    });
  }
  return inflight!;
}
