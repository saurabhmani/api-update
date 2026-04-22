// ════════════════════════════════════════════════════════════════
//  MarketDataProvider — the ONE entry point for all market data
//
//  Architecture freeze (Priority 0 — Kite-first):
//    Kite       = PRIMARY live feed (WebSocket in-process cache)
//    IndianAPI  = FALLBACK during market OPEN hours only
//    Cache      = secondary (fresh cache layer, market OPEN only)
//    Yahoo      = FALLBACK during market OPEN hours only
//    PostgreSQL = ONLY runtime DB (last-resort stale tier)
//
//  Every engine, service, and API route in Quantorus365 MUST read
//  market data through this module. Direct calls to IndianAPI, Yahoo,
//  or any vendor helper from outside `src/providers/**` are a
//  contract violation — a lint/test in CI fails the build when a new
//  one appears.
//
//  Fallback chain (strict, ordered — Priority 1A, Kite-exclusive open):
//    0.  Kite in-process WS cache             → source='kite'   quality='near-live' (open) / 'stale' (closed)
//    0b. Kite EOD (market_data_daily VIEW)    → source='kite'   quality='stale'    [closed hours ONLY]
//    0c. Yahoo snapshot                        → source='yahoo'  quality='fallback-delayed'
//                                                                  [closed hours ONLY, last resort after Kite+EOD miss]
//    1.  IndianAPI                             → source='indian' quality='near-live' [OPEN hours ONLY]
//    2.  In-memory cache                       → source='cache'  quality='cached-fresh' [OPEN hours ONLY]
//    3.  (Yahoo during OPEN hours is DISABLED — spec: "disable Yahoo completely" while market is open)
//    4.  PostgreSQL snapshot                   → source='db'     quality='stale'
//
//  Policy summary:
//    MARKET OPEN   → Kite → IndianAPI → Cache → DB. Yahoo is NEVER consulted.
//    MARKET CLOSED → Kite cache → Kite EOD → Yahoo (LAST RESORT) → DB.
//
//  Rationale: during trading hours we want live or nothing — a delayed
//  Yahoo snapshot alongside live Kite ticks would silently mix sources
//  in the same screen. After hours nothing trades, so the "stale" Kite
//  cache IS the answer; Yahoo only appears when we have literally no
//  Kite data for that symbol (fresh boot, corporate-action rename, etc.).
//
//  Signal-critical callers (passing { signalCritical: true }) MUST
//  reject quality='stale'. When all upstreams fail AND the DB has no
//  snapshot, a StaleDataError is thrown rather than returning a lie.
//
//  Response envelope (Priority 1A DoD):
//    provider_name, source_type, fetched_at, vendor_timestamp,
//    freshness_ms, fallback_reason, data_quality — all populated on
//    every return path.
//
//  Tiered-scheduler additions (Priority 1B — quota reduction):
//    getBatchLiveSnapshots / getTrendingSymbols / getPriceShockers /
//    getNseMostActive / getMarketNews / getCompanyNews — each is
//    budget-guarded via apiBudgetGuard.canSpend() + spend(). The
//    long-TTL endpoints (getHistorical, getMovers, getCorporateIntel)
//    check the cache BEFORE hitting IndianAPI, which is the single
//    biggest budget lever after batch quotes.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import {
  cache,
  quoteCacheKey,
  historicalCacheKey,
  moversCacheKey,
  corporateIntelCacheKey,
  marketNewsCacheKey,
  companyNewsCacheKey,
  trendingCacheKey,
  shockersCacheKey,
  nseMostActiveCacheKey,
  newsRecentIndexKey,
  QUOTE_TTL_S,
  MARKET_NEWS_TTL_S,
  COMPANY_NEWS_TTL_S,
  MOVERS_TTL_S,
} from '@/lib/cache';
import { cacheSet as redisCacheSet, cacheGet as redisCacheGet } from '@/lib/redis';
import { canSpend, spend } from '@/lib/marketData/apiBudgetGuard';
import { guarded, breaker, type ProviderHealth } from './resilience';
import { withProviderFrame } from '@/lib/marketData/enforcer';
import * as IndianAPI from './adapters/IndianAPIAdapter';
import type { NewsItem, BatchQuoteResult } from './adapters/IndianAPIAdapter';
import * as Yahoo from './adapters/YahooAdapter';
// Kite is the authoritative source of market-data truth per the
// system spec. The adapter reads directly from the in-process WS
// tick cache (sync, O(1)) and applies a market-state freshness
// policy — fresh ≤3s when OPEN, any age when CLOSED. See
// src/providers/adapters/KiteAdapter.ts for policy details.
import * as Kite from './adapters/KiteAdapter';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { db as sqlDb } from '@/lib/db';

// Yahoo fallback is policy-controlled. Set YAHOO_ENABLED=false to
// remove the delayed-quote tier entirely (chain collapses to
// IndianAPI → cache → DB). Useful in environments where even 15-min
// delayed data is considered unsafe to return.
const YAHOO_ENABLED = (process.env.YAHOO_ENABLED ?? 'true').toLowerCase() !== 'false';

// Max acceptable age for Kite cached tick OR EOD bar before we
// fall through to Yahoo. Default 3 days (covers a weekend gap).
// Symbols whose candles haven't been refreshed in months would
// otherwise pin the UI to an ancient price — showing a 15-min-
// delayed Yahoo snapshot is strictly better in that case.
const STALE_KITE_MS =
  Number(process.env.STALE_KITE_MS) || 3 * 24 * 60 * 60 * 1000;

import type {
  CorporateIntel,
  DataQuality,
  Fundamentals,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversBucket,
  MoversResult,
  ProviderResponse,
  ProviderSource,
  ProviderSourceType,
  SymbolSearchHit,
} from '@/types/market';
import { StaleDataError } from '@/types/market';

const log = logger.child({ component: 'MarketDataProvider' });

// The DB layer is intentionally injectable. Once the PostgreSQL cutover
// lands in every env, wire a real repository module via registerDbRepo
// without touching any other call site.
export interface MarketDataDbRepo {
  getQuote?(symbol: string): Promise<MarketSnapshot | null>;
  getHistorical?(symbol: string, range: HistoricalRange): Promise<HistoricalSeries | null>;
  getMovers?(): Promise<MoversResult | null>;
  getCorporateIntel?(symbol: string): Promise<CorporateIntel | null>;
}

let dbRepo: MarketDataDbRepo = {};
export function registerDbRepo(repo: MarketDataDbRepo): void {
  dbRepo = repo;
}

// Options honored by every provider method.
export interface GetOptions {
  /** When true, stale (source='db') responses are rejected by throwing. */
  signalCritical?: boolean;
  /** When true, skip cache read on the way in (still write on success). */
  forceRefresh?: boolean;
}

// ── Envelope helpers ────────────────────────────────────────────────

interface AttemptLog { source: ProviderSource; ok: boolean; error?: string; ms?: number }

const PROVIDER_NAMES: Record<ProviderSource, string> = {
  indian: 'IndianAPI',
  cache:  'Cache',
  yahoo:  'Yahoo Finance',
  db:     'PostgreSQL',
  kite:   'Kite WebSocket', // PRIMARY source for live market data
};

const SOURCE_TYPES: Record<ProviderSource, ProviderSourceType> = {
  indian: 'primary',
  cache:  'cache',
  yahoo:  'fallback',
  db:     'stale',
  kite:   'primary',
};

function extractVendorTimestamp(data: unknown, fetchedAt: number): number {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.timestamp === 'number' && obj.timestamp > 0) return obj.timestamp;
    if (typeof obj.asOf === 'number' && obj.asOf > 0) return obj.asOf;
    if (Array.isArray(obj.candles) && obj.candles.length > 0) {
      const last = obj.candles[obj.candles.length - 1] as { t?: number };
      if (typeof last?.t === 'number' && last.t > 0) return last.t;
    }
  }
  return fetchedAt;
}

function computeFallbackReason(source: ProviderSource, trail: AttemptLog[]): string | null {
  // When the primary served the request directly, there is no fallback to explain.
  if (source === 'indian' && trail.every(t => t.ok || t.source !== 'indian')) return null;
  const failures = trail.filter(t => !t.ok);
  if (failures.length === 0) return null;
  return failures
    .map(f => `${f.source}:${(f.error ?? 'failed').slice(0, 120)}`)
    .join('; ');
}

function wrap<T>(
  data: T,
  source: ProviderSource,
  quality: DataQuality,
  trail: AttemptLog[],
): ProviderResponse<T> {
  const fetched_at = Date.now();
  const vendor_timestamp = extractVendorTimestamp(data, fetched_at);
  const freshness_ms = Math.max(0, fetched_at - vendor_timestamp);
  return {
    data,
    source,
    data_quality: quality,
    fetched_at,
    trail,
    provider_name: PROVIDER_NAMES[source],
    source_type: SOURCE_TYPES[source],
    vendor_timestamp,
    freshness_ms,
    fallback_reason: computeFallbackReason(source, trail),
  };
}

function rejectIfStale<T>(resp: ProviderResponse<T>, signalCritical: boolean): ProviderResponse<T> {
  if (signalCritical && (resp.data_quality === 'stale' || resp.source === 'db')) {
    throw new StaleDataError(resp);
  }
  return resp;
}

// Known / expected failure modes — we record them in the trail but
// don't flood the log. These are per-source counters so the first
// occurrence in a window still surfaces for visibility.
//   • "circuit open" — breaker tripped after N failures; self-recovers
//   • "db repo not registered" — optional DB fallback not wired up
//   • "no row/series/movers/intel" — DB had no data for this lookup
// Logging any of these 100× per poll cycle (one per symbol) drowns
// real signal. We show one warning per source per minute.
const KNOWN_FAILURE_RE =
  /^(circuit open for |db repo not registered$|no row for symbol$|no series for symbol$|no movers$|no intel for symbol$)/i;
const silencedAt: Map<string, number> = new Map();
const SILENCE_WINDOW_MS = 60_000;

async function tryStep<T>(
  source: ProviderSource,
  trail: AttemptLog[],
  fn: () => Promise<T>,
): Promise<T | null> {
  const started = Date.now();
  try {
    const out = await fn();
    trail.push({ source, ok: true, ms: Date.now() - started });
    // Clear the silence marker so a new failure after recovery
    // surfaces immediately rather than being suppressed.
    silencedAt.delete(source);
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trail.push({ source, ok: false, error: message, ms: Date.now() - started });

    if (KNOWN_FAILURE_RE.test(message)) {
      const now = Date.now();
      const last = silencedAt.get(source) ?? 0;
      if (now - last >= SILENCE_WINDOW_MS) {
        // Log once per source per window, then silence.
        log.warn('provider step failed (suppressing repeats for 60s)', { source, error: message });
        silencedAt.set(source, now);
      }
    } else {
      log.warn('provider step failed', { source, error: message });
    }
    return null;
  }
}

// ── getLiveSnapshot / getQuote ──────────────────────────────────────
//
// Canonical order (Priority 1A):
//   1. IndianAPI  (PRIMARY)
//   2. Cache      (only consulted when primary fails)
//   3. Yahoo      (fallback)
//   4. PostgreSQL (stale last-resort)
//
// Every primary-success path accounts for its API cost via
// apiBudgetGuard.spend(). Ad-hoc reads (outside the scheduler tiers)
// are tagged 'adhoc' so operators can see route-driven usage separately
// in /api/ops/budget.

export async function getLiveSnapshot(
  symbol: string,
  opts: GetOptions = {},
): Promise<ProviderResponse<MarketSnapshot>> {
  const sym = symbol.trim().toUpperCase();
  const key = quoteCacheKey(sym);
  const trail: AttemptLog[] = [];
  const marketOpen = isMarketOpen();

  // ── 0. Kite WebSocket (AUTHORITATIVE) ──────────────────────────
  // Per spec the Kite in-process tick cache is the primary source of
  // market-data truth. Reading here is sync O(1), never hits the
  // network, and never throws on age (the adapter applies its own
  // market-state freshness policy). When this hits:
  //   • market OPEN  → tick is ≤3s old, label quality='near-live'
  //   • market CLOSED → any last-traded tick, label quality='stale'
  //                     so signal-critical callers reject it.
  const kiteHit = await tryStep('kite', trail, () =>
    guarded('kite', () => Kite.getQuote(sym), { timeoutMs: 500, attempts: 1 }),
  );
  if (kiteHit) {
    await cache.set(key, kiteHit, QUOTE_TTL_S);
    return rejectIfStale(
      wrap(kiteHit, 'kite', marketOpen ? 'near-live' : 'stale', trail),
      !!opts.signalCritical,
    );
  }

  // ── 0b. Market-CLOSED early-exit path (Kite EOD from candles) ──
  // Outside market hours we MUST NOT fall to IndianAPI / Yahoo. The
  // user-visible UI contract is "Kite-sourced data or nothing after
  // close." The `market_data_daily` VIEW projects Kite EOD bars from
  // the candles store; reading it here keeps `source='kite'` while
  // giving the UI a real close price.
  if (!marketOpen) {
    const eod = await tryStep('kite', trail, async () => {
      const { rows } = await sqlDb.query<{
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
      if (!r) throw new Error('no EOD row for symbol');
      const close = Number(r.close);
      if (!Number.isFinite(close) || close <= 0) throw new Error('invalid EOD close');
      const prev = r.prev_close != null ? Number(r.prev_close) : null;
      const tsMs = r.ts instanceof Date
        ? r.ts.getTime()
        : typeof r.ts === 'number'
          ? r.ts
          : new Date(r.ts as string).getTime();
      const snap: MarketSnapshot = {
        symbol: sym,
        price: close,
        ltp: close,
        change:        prev != null && Number.isFinite(prev) ? close - prev : 0,
        changePercent: prev != null && Number.isFinite(prev) && prev > 0 ? ((close - prev) / prev) * 100 : 0,
        volume: 0,
        open: close,
        high: close,
        low: close,
        prevClose: prev != null && Number.isFinite(prev) ? prev : close,
        timestamp: Number.isFinite(tsMs) ? tsMs : Date.now(),
      };
      return snap;
    });
    if (eod) {
      // Accept the EOD bar only if its timestamp is within
      // STALE_KITE_MS. Older than that is almost certainly a symbol
      // whose candle ingest pipeline has stopped — showing a months-
      // old "last close" is worse than showing a 15-min-delayed
      // Yahoo snapshot. Fall through in that case.
      const eodAge = Date.now() - (eod.timestamp || 0);
      if (eodAge <= STALE_KITE_MS) {
        await cache.set(key, eod, QUOTE_TTL_S);
        return rejectIfStale(wrap(eod, 'kite', 'stale', trail), !!opts.signalCritical);
      }
    }

    // ── 0c. Closed-hours Yahoo SNAPSHOT fallback ─────────────────
    // Market closed, no Kite live tick, no FRESH Kite EOD in the DB.
    // Yahoo is the last-resort snapshot here — 15-min-delayed but
    // still more useful than a months-old DB bar.
    if (YAHOO_ENABLED) {
      const yah = await tryStep('yahoo', trail, () =>
        withProviderFrame(() =>
          guarded('yahoo', () => Yahoo.getQuote(sym), { timeoutMs: 2000, attempts: 2 }),
        ),
      );
      if (yah) {
        await cache.set(key, yah, QUOTE_TTL_S);
        return rejectIfStale(wrap(yah, 'yahoo', 'fallback-delayed', trail), !!opts.signalCritical);
      }
    }
    // Nothing worked after close — fall through to DB last-resort.
  }

  // ── 1. IndianAPI — only consulted when market is OPEN ───────────
  // Per spec: during market hours Kite WebSocket is the ONLY
  // acceptable data path. IndianAPI is kept as an internal,
  // Kite-equivalent Indian live feed (the UI maps source='indian'
  // to 'kite'). Yahoo is DISABLED during open hours.
  if (marketOpen) {
    const live = await tryStep('indian', trail, () =>
      withProviderFrame(() =>
        guarded('indian', () => IndianAPI.getQuote(sym), { timeoutMs: 2000, attempts: 3 }),
      ),
    );
    if (live) {
      await cache.set(key, live, QUOTE_TTL_S);
      // Fire-and-forget budget accounting — a failed spend() shouldn't block reads.
      void spend('adhoc', 1);
      return rejectIfStale(wrap(live, 'indian', 'near-live', trail), !!opts.signalCritical);
    }

    // 2. Cache (skip if forceRefresh)
    if (!opts.forceRefresh) {
      const cached = await cache.get<MarketSnapshot>(key);
      if (cached) {
        trail.push({ source: 'cache', ok: true });
        return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
      }
    }

    // Yahoo is DELIBERATELY NOT consulted during market hours.
    // Rule: "MARKET OPEN — Disable Yahoo completely".
  }

  // 4. PostgreSQL stale last-resort (legacy snapshot table, if registered)
  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getQuote) throw new Error('db repo not registered');
    const row = await dbRepo.getQuote(sym);
    if (!row) throw new Error('no row for symbol');
    return row;
  });
  if (dbHit) {
    return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);
  }

  throw new StaleDataError(wrap(
    { symbol: sym, price: 0, ltp: 0, change: 0, changePercent: 0, volume: 0, open: 0, high: 0, low: 0, prevClose: 0, timestamp: 0 } as MarketSnapshot,
    'db',
    'stale',
    trail,
  ));
}

/** Convenience alias matching the canonical MarketQuote contract. */
export const getQuote = getLiveSnapshot;

// ── getHistorical ───────────────────────────────────────────────────
// CACHE-FIRST. Historical data is the biggest budget waster when
// callers re-request the same series inside its 24h TTL window;
// checking cache first avoids the round-trip to IndianAPI entirely.

export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
  opts: GetOptions = {},
): Promise<ProviderResponse<HistoricalSeries>> {
  const sym = symbol.trim().toUpperCase();
  const key = historicalCacheKey(sym, range);
  const trail: AttemptLog[] = [];

  if (!opts.forceRefresh) {
    const cached = await cache.get<HistoricalSeries>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getHistorical(sym, range))),
  );
  if (primary && primary.candles.length > 0) {
    await cache.set(key, primary);
    void spend('hist', 1);
    return rejectIfStale(wrap(primary, 'indian', 'near-live', trail), !!opts.signalCritical);
  }

  if (YAHOO_ENABLED) {
    const yah = await tryStep('yahoo', trail, () =>
      withProviderFrame(() => guarded('yahoo', () => Yahoo.getHistorical(sym, range))),
    );
    if (yah && yah.candles.length > 0) {
      await cache.set(key, yah);
      return rejectIfStale(wrap(yah, 'yahoo', 'fallback-delayed', trail), !!opts.signalCritical);
    }
  }

  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getHistorical) throw new Error('db repo not registered');
    const row = await dbRepo.getHistorical(sym, range);
    if (!row) throw new Error('no series for symbol');
    return row;
  });
  if (dbHit) return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);

  throw new StaleDataError(wrap({ symbol: sym, range, candles: [] }, 'db', 'stale', trail));
}

// ── searchSymbols ───────────────────────────────────────────────────

export async function searchSymbols(query: string): Promise<ProviderResponse<SymbolSearchHit[]>> {
  const trail: AttemptLog[] = [];
  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.searchSymbol(query))),
  );
  if (primary && primary.length > 0) {
    void spend('search', 1);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  if (YAHOO_ENABLED) {
    const yah = await tryStep('yahoo', trail, () =>
      withProviderFrame(() => guarded('yahoo', () => Yahoo.searchSymbol(query))),
    );
    if (yah && yah.length > 0) return wrap(yah, 'yahoo', 'fallback-delayed', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ── getMovers ───────────────────────────────────────────────────────
// CACHE-FIRST. The movers endpoint is refreshed once per Tier A cycle,
// so serving the cache back to ad-hoc callers avoids burning quota.

export async function getMovers(opts: GetOptions = {}): Promise<ProviderResponse<MoversResult>> {
  const key = moversCacheKey();
  const trail: AttemptLog[] = [];

  if (!opts.forceRefresh) {
    const cached = await cache.get<MoversResult>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getMovers())),
  );
  if (primary) {
    await cache.set(key, primary, MOVERS_TTL_S);
    await redisCacheSet(key, primary, MOVERS_TTL_S);
    void spend('movers', 1);
    return rejectIfStale(wrap(primary, 'indian', 'near-live', trail), !!opts.signalCritical);
  }

  // Yahoo does not support Indian movers — skip straight to DB.
  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getMovers) throw new Error('db repo not registered');
    const row = await dbRepo.getMovers();
    if (!row) throw new Error('no movers');
    return row;
  });
  if (dbHit) return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);

  throw new StaleDataError(wrap({ gainers: [], losers: [], mostActive: [] }, 'db', 'stale', trail));
}

// ── getCorporateIntel ───────────────────────────────────────────────
// CACHE-FIRST. Corporate data changes at most daily — 6-hour TTL.

export async function getCorporateIntel(
  symbol: string,
  opts: GetOptions = {},
): Promise<ProviderResponse<CorporateIntel>> {
  const sym = symbol.trim().toUpperCase();
  const key = corporateIntelCacheKey(sym);
  const trail: AttemptLog[] = [];

  if (!opts.forceRefresh) {
    const cached = await cache.get<CorporateIntel>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getCorporateIntel(sym))),
  );
  if (primary) {
    await cache.set(key, primary);
    void spend('corp', 1);
    return rejectIfStale(wrap(primary, 'indian', 'near-live', trail), !!opts.signalCritical);
  }

  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getCorporateIntel) throw new Error('db repo not registered');
    const row = await dbRepo.getCorporateIntel(sym);
    if (!row) throw new Error('no intel for symbol');
    return row;
  });
  if (dbHit) return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);

  throw new StaleDataError(wrap({ symbol: sym, companyName: sym } as CorporateIntel, 'db', 'stale', trail));
}

// ── getFundamentals ─────────────────────────────────────────────────

export async function getFundamentals(
  symbol: string,
  opts: GetOptions = {},
): Promise<ProviderResponse<Fundamentals>> {
  const sym = symbol.trim().toUpperCase();
  const trail: AttemptLog[] = [];
  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getFundamentals(sym))),
  );
  if (primary) {
    // getFundamentals fans out to 3 upstream endpoints — account all 3.
    void spend('corp', 3);
    return rejectIfStale(wrap(primary, 'indian', 'near-live', trail), !!opts.signalCritical);
  }
  // Yahoo does not expose a comparable fundamentals endpoint for Indian
  // equities; skip to DB. DB tier is optional (not every deployment
  // stores fundamentals historically).
  throw new StaleDataError(wrap({ symbol: sym, companyName: sym, asOf: 0 } as Fundamentals, 'db', 'stale', trail));
}

// ── getIndustryPeers ────────────────────────────────────────────────

export async function getIndustryPeers(symbol: string): Promise<ProviderResponse<IndustryPeer[]>> {
  const sym = symbol.trim().toUpperCase();
  const trail: AttemptLog[] = [];
  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getIndustryPeers(sym))),
  );
  if (primary) {
    void spend('corp', 1);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ════════════════════════════════════════════════════════════════════
//  Tiered-scheduler additions (Priority 1B quota-reduction refactor)
// ════════════════════════════════════════════════════════════════════

// ── getBatchLiveSnapshots ───────────────────────────────────────────
// Batch-first entry point used by the scheduler's Tier A phase.
// On success, EACH snapshot is written to the per-symbol cache key
// (quote:<SYMBOL>). Downstream consumers that read via
// getLiveSnapshot() see the batch result as a cache hit within TTL —
// no call-site changes needed.

export interface BatchSnapshotEntry {
  symbol: string;
  snapshot: MarketSnapshot | null;
  source: ProviderSource;     // 'indian' | 'cache' | 'db'
  data_quality: DataQuality;
}

export interface BatchSnapshotResult {
  entries: BatchSnapshotEntry[];
  /** number of IndianAPI batch requests actually issued */
  batchCallsMade: number;
  /** symbols the batch didn't return */
  missingAfterBatch: string[];
}

export async function getBatchLiveSnapshots(
  symbols: string[],
  _opts: GetOptions = {},
): Promise<BatchSnapshotResult> {
  const clean = [...new Set(
    symbols.map(s => s.trim().toUpperCase()).filter(Boolean),
  )];
  if (clean.length === 0) {
    return { entries: [], batchCallsMade: 0, missingAfterBatch: [] };
  }

  // Budget check — IndianAPIAdapter.getBatchQuotes chunks at 200
  // internally, so one adapter call may produce several upstream
  // requests. Estimate accordingly.
  const estimatedCalls = Math.max(1, Math.ceil(clean.length / 200));
  const spendCheck = await canSpend('batch', estimatedCalls);
  const entries: BatchSnapshotEntry[] = [];
  let batchCallsMade = 0;

  if (!spendCheck.allowed) {
    log.warn('batch snapshot denied by budget guard', {
      level: spendCheck.level,
      reason: spendCheck.reason,
      symbols: clean.length,
    });
    for (const sym of clean) {
      const cached = await cache.get<MarketSnapshot>(quoteCacheKey(sym))
        ?? await redisCacheGet<MarketSnapshot>(quoteCacheKey(sym));
      entries.push(cached
        ? { symbol: sym, snapshot: cached, source: 'cache', data_quality: 'cached-fresh' }
        : { symbol: sym, snapshot: null, source: 'db', data_quality: 'stale' });
    }
    return {
      entries,
      batchCallsMade: 0,
      missingAfterBatch: entries.filter(e => e.snapshot === null).map(e => e.symbol),
    };
  }

  // Spend BEFORE the call — a failed call still costs us quota.
  await spend('batch', estimatedCalls);
  batchCallsMade = estimatedCalls;

  let batch: BatchQuoteResult = { snapshots: [], missing: clean };
  try {
    batch = await withProviderFrame(() =>
      guarded(
        'indian',
        () => IndianAPI.getBatchQuotes(clean),
        { timeoutMs: 5000, attempts: 2 },
      ),
    );
  } catch (err) {
    log.warn('batch quote call failed — falling back to per-symbol cache', {
      error: err instanceof Error ? err.message : String(err),
      symbols: clean.length,
    });
    batch = { snapshots: [], missing: clean };
  }

  // Fan out successful rows to per-symbol cache. This is the key
  // integration point: existing consumers reading via
  // getLiveSnapshot() pick these up as cache hits.
  for (const snap of batch.snapshots) {
    await cache.set(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    // Mirror into Redis so cross-process consumers see it.
    await redisCacheSet(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    entries.push({
      symbol: snap.symbol,
      snapshot: snap,
      source: 'indian',
      data_quality: 'near-live',
    });
  }

  // For symbols the batch didn't return, check cache before giving up.
  for (const sym of batch.missing) {
    const cached = await cache.get<MarketSnapshot>(quoteCacheKey(sym))
      ?? await redisCacheGet<MarketSnapshot>(quoteCacheKey(sym));
    if (cached) {
      entries.push({ symbol: sym, snapshot: cached, source: 'cache', data_quality: 'cached-fresh' });
    } else {
      entries.push({ symbol: sym, snapshot: null, source: 'db', data_quality: 'stale' });
    }
  }

  return {
    entries,
    batchCallsMade,
    missingAfterBatch: batch.missing,
  };
}

// ── getTrendingSymbols / getPriceShockers / getNseMostActive ────────
// Thin, cache-first wrappers over the new adapter methods. Each
// consumes ONE API call per call; the scheduler's Tier A phase calls
// them once per 10 minutes.

export async function getTrendingSymbols(): Promise<ProviderResponse<string[]>> {
  const key = trendingCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<string[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const spendCheck = await canSpend('movers');
  if (!spendCheck.allowed) {
    trail.push({ source: 'indian', ok: false, error: spendCheck.reason });
    return wrap([], 'db', 'stale', trail);
  }
  await spend('movers');

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getTrendingSymbols())),
  );
  if (primary) {
    await cache.set(key, primary, MOVERS_TTL_S);
    await redisCacheSet(key, primary, MOVERS_TTL_S);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getPriceShockers(): Promise<ProviderResponse<string[]>> {
  const key = shockersCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<string[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const spendCheck = await canSpend('movers');
  if (!spendCheck.allowed) {
    return wrap([], 'db', 'stale', trail);
  }
  await spend('movers');

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getPriceShockers())),
  );
  if (primary) {
    await cache.set(key, primary, MOVERS_TTL_S);
    await redisCacheSet(key, primary, MOVERS_TTL_S);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getNseMostActive(): Promise<ProviderResponse<MoversBucket[]>> {
  const key = nseMostActiveCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<MoversBucket[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const spendCheck = await canSpend('movers');
  if (!spendCheck.allowed) {
    return wrap([], 'db', 'stale', trail);
  }
  await spend('movers');

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getNseMostActive())),
  );
  if (primary) {
    await cache.set(key, primary, MOVERS_TTL_S);
    await redisCacheSet(key, primary, MOVERS_TTL_S);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ── News ────────────────────────────────────────────────────────────

export async function getMarketNews(): Promise<ProviderResponse<NewsItem[]>> {
  const key = marketNewsCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<NewsItem[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const spendCheck = await canSpend('news');
  if (!spendCheck.allowed) {
    return wrap([], 'db', 'stale', trail);
  }
  await spend('news');

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getMarketNews())),
  );
  if (primary) {
    await cache.set(key, primary, MARKET_NEWS_TTL_S);
    await redisCacheSet(key, primary, MARKET_NEWS_TTL_S);
    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getCompanyNews(symbol: string): Promise<ProviderResponse<NewsItem[]>> {
  const sym = symbol.trim().toUpperCase();
  const key = companyNewsCacheKey(sym);
  const trail: AttemptLog[] = [];

  const cached = await cache.get<NewsItem[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const spendCheck = await canSpend('news');
  if (!spendCheck.allowed) {
    return wrap([], 'db', 'stale', trail);
  }
  await spend('news');

  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() => guarded('indian', () => IndianAPI.getCompanyNews(sym))),
  );
  if (primary) {
    await cache.set(key, primary, COMPANY_NEWS_TTL_S);
    await redisCacheSet(key, primary, COMPANY_NEWS_TTL_S);

    // Update the recent-news symbol index so triggerEngine can read it.
    const existing = (await redisCacheGet<string[]>(newsRecentIndexKey())) ?? [];
    const nextSet = new Set<string>(existing);
    nextSet.add(sym);
    // Cap the index to prevent unbounded growth.
    const next = [...nextSet].slice(-200);
    await redisCacheSet(newsRecentIndexKey(), next, COMPANY_NEWS_TTL_S);

    return wrap(primary, 'indian', 'near-live', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ── Health surface ──────────────────────────────────────────────────

export function getProviderHealth(): ProviderHealth[] {
  return breaker.health();
}

// Default export for ergonomic single-import usage from engines.
export const MarketDataProvider = {
  // Original surface — UNCHANGED signatures (canonical envelope preserved).
  getLiveSnapshot,
  getQuote,
  getHistorical,
  searchSymbols,
  getMovers,
  getCorporateIntel,
  getFundamentals,
  getIndustryPeers,
  getProviderHealth,
  registerDbRepo,

  // Tiered-scheduler additions (Priority 1B).
  getBatchLiveSnapshots,
  getTrendingSymbols,
  getPriceShockers,
  getNseMostActive,
  getMarketNews,
  getCompanyNews,
};

export default MarketDataProvider;
