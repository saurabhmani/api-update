/**
 * GET /api/ticker
 *
 * Returns lightweight ticker data for the moving strip.
 * Read path (post-Kite-removal): // @deprecated marker
 *   1. Redis strip cache (30s TTL)     — serves most hits
 *   2. rankings table → top N symbols  — provides the symbol universe
 *   3. fetchYahooQuotesBatch(symbols)  — ONE HTTP call fills LTPs // @deprecated marker
 *   4. rankings.ltp / pct_change       — last-resort DB fallback
 *
 * Returns top 30 ranked symbols with symbol, name, ltp, change%.
 * Cached at Redis key 'ticker:strip' for 30s so repeated polls don't
 * fan out.
 */

import { NextRequest, NextResponse }   from 'next/server';
import { requireSession }              from '@/lib/session';
import { cacheGet, cacheSet }          from '@/lib/redis';
import { fetchYahooQuotesBatch }       from '@/lib/marketData/yahooBatch'; // @deprecated marker
import { getMarketEnvelope }           from '@/lib/marketData/marketHours';
import { getTopRankings }              from '@/services/rankingsService';
import { ensureUniverseReady }         from '@/lib/startup/ensureUniverseReady';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export interface TickerItem {
  symbol:         string;
  name:           string;
  ltp:            number;
  change_percent: number;
  change_abs:     number;
}

/** Spec MARKET-AWARENESS — data-source label embedded in every
 *  /api/ticker response so the UI knows whether the prices are live
 *  or last-close. */
export type TickerDataSource =
  | 'live_feed'        // Yahoo enrichment ran during open market
  | 'cached_ticker'    // 30s strip cache hit
  | 'last_rankings_db' // DB fallback (closed market or Yahoo miss)
  | 'unknown';

const STRIP_KEY = 'ticker:strip';
const STRIP_TTL = 30;
const LIMIT     = 30;

// TICKER-TIMEOUT-FIX (2026-05) — wrap the Yahoo batch in a wall-clock
// race so a slow upstream cannot wedge the request past nginx's read
// timeout. Default 4s during the trade window; configurable via
// TICKER_YAHOO_TIMEOUT_MS. On timeout we fall back to DB rankings
// values and label the response data_source='last_rankings_db' so the
// strip degrades gracefully instead of returning a 504.
const TICKER_YAHOO_TIMEOUT_MS = (() => {
  const raw = Number(process.env.TICKER_YAHOO_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.floor(raw);
  // Spec TICKER-504-FIX — bump default to 6s to allow for IndianAPI
  // rate-limiter serialization (30 symbols @ 500ms gap = 15s queue depth
  // worst-case, but with concurrency=3 it's 5s). 4s was too tight.
  return 6_000;
})();
// On a degraded response (Yahoo timeout / error), serve a shorter TTL
// from cache so the strip recovers quickly the moment Yahoo is back.
const STRIP_TTL_DEGRADED = 10;

async function fetchYahooWithTimeout(
  symbols: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ map: Map<string, { price: number | null; pChange: number | null; change: number | null }>; degraded: boolean; reason: string | null }> {
  if (symbols.length === 0) {
    return { map: new Map(), degraded: false, reason: null };
  }
  
  const map = new Map<string, any>();
  let degraded = false;
  let reason: string | null = null;
  
  const BATCH_SIZE = 10;
  const CONCURRENCY = 3;
  
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }
  
  const timeoutP = new Promise<'__TICKER_TIMEOUT__'>((resolve) => {
    setTimeout(() => resolve('__TICKER_TIMEOUT__'), timeoutMs);
  });
  
  let batchIndex = 0;
  async function worker() {
    while (batchIndex < batches.length) {
      if (signal?.aborted) {
        degraded = true;
        break;
      }
      const currentBatch = batches[batchIndex++];
      try {
        const result = await Promise.race([
          fetchYahooQuotesBatch(currentBatch, signal),
          timeoutP
        ]);
        if (result === '__TICKER_TIMEOUT__') {
           degraded = true;
           reason = `yahoo_timeout_${timeoutMs}ms`;
           break;
        }
        for (const [k, v] of (result as Map<string, any>).entries()) {
           map.set(k, v);
        }
      } catch (err: any) {
         if (err.name === 'AbortError') {
             degraded = true;
         } else {
             degraded = true;
             reason = err?.message ?? String(err);
         }
      }
    }
  }
  
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, batches.length); i++) {
    workers.push(worker());
  }
  
  const winner = await Promise.race([
    Promise.all(workers),
    timeoutP
  ]);
  
  if (winner === '__TICKER_TIMEOUT__') {
    degraded = true;
    reason = `timeout_partial_${timeoutMs}ms`;
    console.warn(`[/api/ticker] Yahoo batch timeout after ${timeoutMs}ms — degrading to partial DB rankings`);
  }
  
  return { map, degraded, reason };
}

export async function GET(req: NextRequest) {
  // Spec TICKER-504-FIX — wrap the entire handler in a wall-clock race.
  // Next.js Route Handlers have a 10s default execution limit on many
  // platforms (Vercel/Nginx). If DB + Yahoo take >10s, the gateway returns
  // 504. We race against 9s and return a cached/empty response if we lose.
  const timeoutMs = 9_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      handleRequest(req, controller.signal),
      new Promise<NextResponse>((_, reject) =>
        setTimeout(() => reject(new Error('TICKER_HANDLER_TIMEOUT')), timeoutMs)
      )
    ]);
    clearTimeout(timeoutId);
    return result;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.message === 'TICKER_HANDLER_TIMEOUT' || err.name === 'AbortError') {
      console.warn('[/api/ticker] handler timeout reached (9s) — falling back to cache/empty');
      // Try one last-ditch cache read
      const stripped = await cacheGet<{ items: TickerItem[]; source: string }>(STRIP_KEY);
      if (stripped?.items?.length) {
        return NextResponse.json({
          items:  stripped.items,
          source: `${stripped.source}+timeout_fallback`,
          count:  stripped.items.length,
          data_source: 'cached_ticker',
          degraded: true
        });
      }
      return NextResponse.json({ items: [], source: 'timeout', count: 0, degraded: true });
    }
    throw err;
  }
}

async function handleRequest(_req: NextRequest, signal?: AbortSignal) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // Spec STEP 2 — universe init guard. getTopRankings → marketDataResolver
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      {
        error:  'Universe not ready',
        code:   'UNIVERSE_NOT_READY',
        detail: universeReady.error,
      },
      { status: 503 },
    );
  }

  const market = getMarketEnvelope();
  const mode: 'live' | 'market_closed' = market.isOpen ? 'live' : 'market_closed';

  // ── Step 1: assembled strip cache ─────────────────────────────
  const stripped = await cacheGet<{ items: TickerItem[]; source: string }>(STRIP_KEY);
  if (stripped?.items?.length) {
    return NextResponse.json({
      items:  stripped.items,
      source: `${stripped.source}+cached`,
      count:  stripped.items.length,
      mode,
      market_state: market.state,
      market_label: market.label,
      data_source:  'cached_ticker' satisfies TickerDataSource,
    });
  }

  let items: TickerItem[] = [];
  let source = 'yahoo'; // @deprecated marker
  let dataSource: TickerDataSource = 'unknown';

  try {
    // ── Step 2: universe from the canonical ranking comparator ─
    // Previously the ticker did its own SQL with `ORDER BY score DESC`
    // — i.e. a hidden raw-score order that disagreed with /api/rankings
    // (which sorts by opportunity_rank with deterministic tie-breakers).
    // The ticker now reuses `getTopRankings` so the strip's top symbols
    // can never broadcast a different priority order than the rest of
    // the platform. allowExternalFallback follows market.isOpen so the
    // strip never burns Yahoo / NSE quota on a Saturday.
    // Ticker strip rankings — wrapped in a race to prevent DB latency from 504ing
  const ranked = await Promise.race([
    getTopRankings(LIMIT, 1, undefined, market.isOpen),
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), 5000))
  ]).catch(err => {
    console.error('[TICKER_DB_ERROR]', err.message);
    return [];
  }) as Awaited<ReturnType<typeof getTopRankings>>;
    const deduped = (ranked.data ?? []).slice(0, LIMIT).map((r) => ({
      symbol:         String(r.symbol || '').toUpperCase(),
      name:           r.name || r.symbol,
      instrument_key: r.instrument_key || `NSE_EQ|${r.symbol}`,
      db_ltp:         Number(r.ltp) || 0,
      db_pct:         Number(r.pct_change) || 0,
      // Carry opportunity_rank through so debug payloads can confirm
      // the order matches the rankings page byte-for-byte.
      opportunity_rank: r.opportunity_rank ?? null,
    }));

    // Spec MARKET-AWARENESS — Yahoo enrichment is ONLY meaningful
    // when the market is open. Off-hours the upstream returns
    // last-close (or stale) prices that we already have in the DB,
    // so we skip the network round-trip and label honestly.
    // TICKER-TIMEOUT-FIX (2026-05) — wall-clock race against
    // TICKER_YAHOO_TIMEOUT_MS. On timeout/error we proceed with an
    // empty map and the per-row fallback below serves the DB price.
    let degradedReason: string | null = null;
    const yahooResp = market.isOpen && deduped.length > 0
      ? await fetchYahooWithTimeout(
          deduped.map((r) => r.symbol).filter(Boolean),
          TICKER_YAHOO_TIMEOUT_MS,
          signal,
        )
      : { map: new Map(), degraded: false, reason: null };
    const yahooMap = yahooResp.map;
    if (yahooResp.degraded) degradedReason = yahooResp.reason;

    let yahooHits = 0; // @deprecated marker
    items = deduped.map(row => {
      const sym = row.symbol;
      const y = yahooMap.get(sym); // @deprecated marker
      if (y && y.price != null && y.price > 0) {
        yahooHits += 1; // @deprecated marker
        return {
          symbol:         sym,
          name:           String(row.name || sym),
          ltp:            y.price,
          change_percent: y.pChange ?? 0,
          change_abs:     y.change  ?? 0,
        } satisfies TickerItem;
      }
      // ── Step 4: fallback to DB rankings values ──────────────
      const dbLtp = row.db_ltp;
      const dbPct = row.db_pct;
      return {
        symbol:         sym,
        name:           String(row.name || sym),
        ltp:            dbLtp,
        change_percent: dbPct,
        change_abs:     dbLtp > 0 && dbPct !== 0 && (100 + dbPct) !== 0
          ? (dbLtp * dbPct) / (100 + dbPct)
          : 0,
      } satisfies TickerItem;
    }).filter(i => i.ltp > 0 || i.change_percent !== 0);

    if (!market.isOpen) {
      // Closed: regardless of cache, the data is from the rankings
      // table — last close at best.
      source     = 'db';
      dataSource = 'last_rankings_db';
    } else if (yahooHits === items.length && items.length > 0) {
      source     = 'yahoo'; // @deprecated marker
      dataSource = 'live_feed';
    } else if (yahooHits > 0) {
      source     = 'yahoo+db'; // @deprecated marker
      dataSource = 'live_feed';
    } else {
      source     = 'db';
      dataSource = 'last_rankings_db';
    }
  } catch (err: any) {
    console.error('[/api/ticker] universe error:', err?.message, err?.code, err?.sqlMessage);
    return NextResponse.json(
      {
        error:   'Failed to load ticker data',
        details: err?.sqlMessage || err?.message || 'unknown',
        code:    err?.code,
        mode,
        market_state: market.state,
        market_label: market.label,
        data_source:  'unknown' satisfies TickerDataSource,
      },
      { status: 500 },
    );
  }

  // Cache hit policy: when degraded, use the short TTL so we re-probe
  // Yahoo sooner; when healthy, use the full TTL.
  // We cannot easily reach `degradedReason` here without hoisting it
  // out of the try-block, but the dataSource encodes the same signal:
  // a degraded request resolved to 'last_rankings_db'.
  if (items.length) {
    const ttl = dataSource === 'last_rankings_db' && market.isOpen
      ? STRIP_TTL_DEGRADED
      : STRIP_TTL;
    await cacheSet(STRIP_KEY, { items, source }, ttl);
  }

  return NextResponse.json({
    items, source, count: items.length,
    mode,
    market_state: market.state,
    market_label: market.label,
    data_source:  dataSource,
    // TICKER-TIMEOUT-FIX (2026-05) — surface a `degraded` boolean the
    // UI can hang a status pip on without parsing data_source strings.
    degraded:     market.isOpen && dataSource === 'last_rankings_db',
  });
}
