// ════════════════════════════════════════════════════════════════
//  MarketDataProvider — the ONE entry point for all market data
//
//  Architecture freeze (Priority 0 — Kite-first): // @deprecated marker
//    Kite       = PRIMARY live feed (WebSocket in-process cache) // @deprecated marker
//    IndianAPI  = FALLBACK during market OPEN hours only
//    Cache      = secondary (fresh cache layer, market OPEN only)
//    Yahoo      = FALLBACK during market OPEN hours only // @deprecated marker
//    PostgreSQL = ONLY runtime DB (last-resort stale tier)
//
//  Every engine, service, and API route in Quantorus365 MUST read
//  market data through this module. Direct calls to IndianAPI, Yahoo, // @deprecated marker
//  or any vendor helper from outside `src/providers/**` are a
//  contract violation — a lint/test in CI fails the build when a new
//  one appears.
//
//  Fallback chain (strict, ordered — Priority 1A, Kite-exclusive open): // @deprecated marker
//    0.  Kite in-process WS cache             → source='kite'   quality='near-live' (open) / 'stale' (closed) // @deprecated marker
//    0b. Kite EOD (market_data_daily VIEW)    → source='kite'   quality='stale'    [closed hours ONLY] // @deprecated marker
//    0c. Yahoo snapshot                        → source='yahoo'  quality='fallback-delayed' // @deprecated marker
//                                                                  [closed hours ONLY, last resort after Kite+EOD miss] // @deprecated marker
//    1.  IndianAPI                             → source='indian' quality='near-live' [OPEN hours ONLY]
//    2.  In-memory cache                       → source='cache'  quality='cached-fresh' [OPEN hours ONLY]
//    3.  (Yahoo during OPEN hours is DISABLED — spec: "disable Yahoo completely" while market is open) // @deprecated marker
//    4.  PostgreSQL snapshot                   → source='db'     quality='stale'
//
//  Policy summary:
//    MARKET OPEN   → Kite → IndianAPI → Cache → DB. Yahoo is NEVER consulted. // @deprecated marker
//    MARKET CLOSED → Kite cache → Kite EOD → Yahoo (LAST RESORT) → DB. // @deprecated marker
//
//  Rationale: during trading hours we want live or nothing — a delayed
//  Yahoo snapshot alongside live Kite ticks would silently mix sources // @deprecated marker
//  in the same screen. After hours nothing trades, so the "stale" Kite // @deprecated marker
//  cache IS the answer; Yahoo only appears when we have literally no // @deprecated marker
//  Kite data for that symbol (fresh boot, corporate-action rename, etc.). // @deprecated marker
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
import * as Yahoo from './adapters/YahooAdapter'; // @deprecated marker
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { mayUseYahoo } from '@/lib/marketData/providerFlags'; // @deprecated marker
import { propagateTick } from '@/lib/marketData/tickPropagator';

// Yahoo is GATED. Step 2 of the IndianAPI cutover forbids any // @deprecated marker
// Yahoo branch in production unless an operator has set // @deprecated marker
// YAHOO_EMERGENCY_FALLBACK_ENABLED=true (or selected MARKET_DATA_PROVIDER=yahoo). // @deprecated marker
// Legacy YAHOO_ENABLED is still honoured for backwards compat: an
// operator who has explicitly set YAHOO_ENABLED=false retains the
// kill-switch. Otherwise the new emergency flag is the only gate.
const LEGACY_YAHOO_KILL_SWITCH =
  (process.env.YAHOO_ENABLED ?? 'true').toLowerCase() === 'false';
function yahooAllowed(): boolean { // @deprecated marker
  if (LEGACY_YAHOO_KILL_SWITCH) return false;
  return mayUseYahoo(); // @deprecated marker
}

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
  getQuote?(symbol: string): Promise<MarketSnapshot | null>; // @deprecated marker
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
  yahoo:  'Yahoo Finance', // @deprecated marker
  db:     'PostgreSQL',
  kite:   'Kite WebSocket', // PRIMARY source for live market data // @deprecated marker
};

const SOURCE_TYPES: Record<ProviderSource, ProviderSourceType> = {
  indian: 'primary',
  cache:  'cache',
  yahoo:  'fallback', // @deprecated marker
  db:     'stale',
  kite:   'primary', // @deprecated marker
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

// ── getLiveSnapshot / getQuote ────────────────────────────────────── // @deprecated marker
//
// Canonical order (Priority 1A):
//   1. IndianAPI  (PRIMARY)
//   2. Cache      (only consulted when primary fails)
//   3. Yahoo      (fallback) // @deprecated marker
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

  // ── 1. IndianAPI (PRIMARY live-quote source) ─────────────────
  // The IndianAPI adapter exposes a single-symbol /stock endpoint.
  // We hit it through the resilience guard so a transient outage
  // automatically rotates to cache → fallback below.
  // Spec FIX-DATA-PIPELINE §1: 5s timeout, max 2 attempts. Anything
  // slower must release control to the cache → Yahoo → DB cascade so
  // the operator never sees a 15s blocking call from a stalled
  // upstream. Logged via [PROVIDER] tags so the success/fail path is
  // grep-able from production logs.
  console.log('[PROVIDER] IndianAPI getQuote →', sym);
  const primary = await tryStep('indian', trail, () =>
    withProviderFrame(() =>
      guarded('indian', () => IndianAPI.getQuote(sym), { timeoutMs: 5000, attempts: 2 }), // @deprecated marker
    ),
  );
  if (primary) {
    console.log('[PROVIDER] IndianAPI success', sym);
    await cache.set(key, primary, QUOTE_TTL_S);
    // Fan into the per-symbol tick channel for /api/market/stream.
    void propagateTick(primary);
    void spend('adhoc', 1);
    return rejectIfStale(
      wrap(primary, 'indian', 'near-live', trail),
      !!opts.signalCritical,
    );
  }
  console.log('[PROVIDER] IndianAPI fail → cascading fallback for', sym);

  // ── 2. Cache (skip if forceRefresh) ─────────────────────────────
  if (!opts.forceRefresh) {
    const cached = await cache.get<MarketSnapshot>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  // ── 3. Yahoo emergency fallback ────────────────────────────────
  // Spec FIX-DATA-PIPELINE §3: when IndianAPI fails AND there's no
  // fresh cache, Yahoo is the next provider in the hard-fallback
  // chain (NSE → Yahoo → snapshot lives in marketDataResolver; this
  // is the per-symbol path). Gated via `yahooAllowed()` which now
  // honours YAHOO_EMERGENCY_FALLBACK_ENABLED so the env can flip
  // it on without a code change.
  if (yahooAllowed()) { // @deprecated marker
    console.log('[PROVIDER] fallback used → Yahoo for', sym);
    const yah = await tryStep('yahoo', trail, () => // @deprecated marker
      withProviderFrame(() =>
        guarded('yahoo', () => Yahoo.getQuote(sym), { timeoutMs: 5000, attempts: 2 }), // @deprecated marker
      ),
    );
    if (yah) {
      console.log('[PROVIDER] Yahoo success', sym);
      await cache.set(key, yah, QUOTE_TTL_S);
      return rejectIfStale(
        wrap(yah, 'yahoo', marketOpen ? 'fallback-delayed' : 'stale', trail), // @deprecated marker
        !!opts.signalCritical,
      );
    }
    console.log('[PROVIDER] Yahoo fail', sym);
  }

  // 4. PostgreSQL stale last-resort (legacy snapshot table, if registered)
  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getQuote) throw new Error('db repo not registered'); // @deprecated marker
    const row = await dbRepo.getQuote(sym); // @deprecated marker
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
export const getQuote = getLiveSnapshot; // @deprecated marker

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

  if (yahooAllowed()) { // @deprecated marker
    const yah = await tryStep('yahoo', trail, () => // @deprecated marker
      withProviderFrame(() => guarded('yahoo', () => Yahoo.getHistorical(sym, range))), // @deprecated marker
    );
    if (yah && yah.candles.length > 0) {
      await cache.set(key, yah);
      return rejectIfStale(wrap(yah, 'yahoo', 'fallback-delayed', trail), !!opts.signalCritical); // @deprecated marker
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
  if (yahooAllowed()) { // @deprecated marker
    const yah = await tryStep('yahoo', trail, () => // @deprecated marker
      withProviderFrame(() => guarded('yahoo', () => Yahoo.searchSymbol(query))), // @deprecated marker
    );
    if (yah && yah.length > 0) return wrap(yah, 'yahoo', 'fallback-delayed', trail); // @deprecated marker
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

  // Yahoo does not support Indian movers — skip straight to DB. // @deprecated marker
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
  // Yahoo does not expose a comparable fundamentals endpoint for Indian // @deprecated marker
  // equities; skip to DB. DB tier is optional (not every deployment
  // stores fundamentals historically).
  throw new StaleDataError(wrap({ symbol: sym, companyName: sym, asOf: 0 } as Fundamentals, 'db', 'stale', trail));
}

// ── getIndustryPeers ────────────────────────────────────────────────

/**
 * IndianAPI's `/industry_peers` route was removed from the catalog
 * on 2026-05-01 (no working path on this plan — verified 404 across
 * every plausible alternate). Returning `[]` directly here avoids
 * the otherwise-pointless `IndianAPI.getIndustryPeers` call (which
 * now throws via `removedEndpoint`) and the associated budget-guard
 * debit / error-log noise. Callers already treat empty as "no peers
 * known"; restore the live call here if a working route ships later.
 */
export async function getIndustryPeers(symbol: string): Promise<ProviderResponse<IndustryPeer[]>> {
  const sym = symbol.trim().toUpperCase();
  void sym;
  const trail: AttemptLog[] = [];
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

  // 1. Cache-first per symbol. Tier A populated cache within QUOTE_TTL_S
  //    so the rescore loop / SSE fan-out stay free here.
  const entries: BatchSnapshotEntry[] = [];
  const misses: string[] = [];
  for (const sym of clean) {
    const cached = await cache.get<MarketSnapshot>(quoteCacheKey(sym))
      ?? await redisCacheGet<MarketSnapshot>(quoteCacheKey(sym));
    if (cached) {
      entries.push({ symbol: sym, snapshot: cached, source: 'cache', data_quality: 'cached-fresh' });
    } else {
      misses.push(sym);
    }
  }
  if (misses.length === 0) {
    return { entries, batchCallsMade: 0, missingAfterBatch: [] };
  }

  // 2. Budget gate — IndianAPI's batch is now EMULATED via concurrent
  //    /stock fan-out (1 upstream call per symbol). Estimate the cost
  //    accordingly and refuse the call if the budget guard says no.
  const estimatedCalls = misses.length;
  const spendCheck = await canSpend('batch', estimatedCalls);
  if (!spendCheck.allowed) {
    log.warn('batch snapshot denied by budget guard', {
      level: spendCheck.level,
      reason: spendCheck.reason,
      symbols: misses.length,
    });
    for (const sym of misses) {
      entries.push({ symbol: sym, snapshot: null, source: 'db', data_quality: 'stale' });
    }
    return {
      entries,
      batchCallsMade: 0,
      missingAfterBatch: misses,
    };
  }

  // 3. Spend BEFORE the call — a partial-success still consumed the
  //    quota for every /stock that fired. Matches the existing
  //    apiBudgetGuard semantics elsewhere in the codebase.
  await spend('batch', estimatedCalls);
  const batchCallsMade = estimatedCalls;

  let batch: BatchQuoteResult = { snapshots: [], missing: misses };
  try {
    batch = await withProviderFrame(() =>
      guarded(
        'indian',
        () => IndianAPI.getBatchQuotes(misses),
        // 60s outer cap on the whole emulated batch. Per-symbol
        // /stock has its own ~15s axios timeout (INDIANAPI_TIMEOUT_MS);
        // worst-case 25 symbols at concurrency=3 = ~9 rounds × 15s =
        // 135s, but in practice most symbols return in <1s and only
        // 1-2 stragglers hit the per-call timeout. 60s leaves room
        // for the slow tail without holding the caller indefinitely.
        // attempts=1: the adapter already absorbs per-symbol failures
        // into `missing[]`, so a wrapper-level retry would just double
        // the latency for symbols that already settled.
        { timeoutMs: 60000, attempts: 1 },
      ),
    );
  } catch (err) {
    log.warn('emulated batch quote call failed — falling back to stale for misses', {
      error: err instanceof Error ? err.message : String(err),
      symbols: misses.length,
    });
    batch = { snapshots: [], missing: misses };
  }

  // 4. Fan successful rows out to the per-symbol cache — downstream
  //    consumers reading via getLiveSnapshot pick these up as cache
  //    hits within QUOTE_TTL_S, exactly like the original batch path.
  for (const snap of batch.snapshots) {
    await cache.set(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    await redisCacheSet(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    // Tier A populates ticks too — keeps /api/market/stream live for
    // every symbol the scheduler refreshes, not only ad-hoc resolves.
    void propagateTick(snap);
    entries.push({
      symbol: snap.symbol,
      snapshot: snap,
      source: 'indian',
      data_quality: 'near-live',
    });
  }
  for (const sym of batch.missing) {
    entries.push({ symbol: sym, snapshot: null, source: 'db', data_quality: 'stale' });
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

/**
 * Spec-named alias — `getIndianApiLiveQuotesByStockEndpoint`. Same
 * function as `getBatchLiveSnapshots`; the alternate name spells out
 * the implementation strategy (single-symbol /stock fan-out emulating
 * the dead /nse/batch_quote route) so call-site authors don't have to
 * read the implementation to understand the cost model.
 */
export const getIndianApiLiveQuotesByStockEndpoint = getBatchLiveSnapshots;

// Default export for ergonomic single-import usage from engines.
export const MarketDataProvider = {
  // Original surface — UNCHANGED signatures (canonical envelope preserved).
  getLiveSnapshot,
  getQuote, // @deprecated marker
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
  getIndianApiLiveQuotesByStockEndpoint,
  getTrendingSymbols,
  getPriceShockers,
  getNseMostActive,
  getMarketNews,
  getCompanyNews,
};

export default MarketDataProvider;
