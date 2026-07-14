// ════════════════════════════════════════════════════════════════
//  MarketDataProvider — the ONE entry point for all market data
//
//  Quote / historical / search / batch (Phase 1):
//    Kite → Cache → Yahoo (via yahooAllowed / mayUseYahoo) → PostgreSQL
//
//  Phase 2 (movers / news / corporate / fundamentals / discovery):
//    Cache → rankings MySQL / Yahoo fundamentals → empty or stale
//    No third-party Indian equity REST vendor on these paths.
//
//  Every engine, service, and API route in Quantorus365 MUST read
//  market data through this module. Direct calls to vendor helpers
//  from outside `src/providers/**` are a contract violation.
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
//    getNseMostActive / getMarketNews / getCompanyNews — discovery
//    and news helpers stay exported for the scheduler; they serve
//    cache or empty rather than burning quota on removed endpoints.
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
  QUOTE_TTL_S,
  CORP_TTL_S,
  MOVERS_TTL_S,
} from '@/lib/cache';
import { cacheSet as redisCacheSet, cacheGet as redisCacheGet } from '@/lib/redis';
import { guarded, breaker, type ProviderHealth } from './resilience';
import { withProviderFrame } from '@/lib/marketData/enforcer';
import * as Kite from './adapters/KiteAdapter';
import { UnsupportedFeatureError } from './adapters/UnsupportedFeatureError';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';
import * as Yahoo from './adapters/YahooAdapter';
import { fetchYahooFundamentals } from '@/lib/marketData/yahooFundamentals';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import {
  getMarketDataProvider,
  getPrimaryFallbackProvider,
  isKitePrimary,
  mayUseYahoo,
  type ProviderCapabilityTag,
} from '@/lib/marketData/providerFlags';
import { propagateTick } from '@/lib/marketData/tickPropagator';
import { db } from '@/lib/db';

/** Unified news row — kept for scheduler / MDP exports; routes use RSS. */
export interface NewsItem {
  symbol?: string;
  headline: string;
  source?: string;
  url?: string;
  /** epoch ms */
  publishedAt: number;
  summary?: string;
}

// Yahoo is gated by mayUseYahoo() plus a legacy YAHOO_ENABLED=false kill-switch.
const LEGACY_YAHOO_KILL_SWITCH =
  (process.env.YAHOO_ENABLED ?? 'true').toLowerCase() === 'false';
function yahooAllowed(): boolean {
  if (LEGACY_YAHOO_KILL_SWITCH) return false;
  return mayUseYahoo();
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
  cache:  'Cache',
  yahoo:  'Yahoo Finance', // @deprecated marker
  db:     'MySQL',
  kite:   'Kite Connect',
};

const SOURCE_TYPES: Record<ProviderSource, ProviderSourceType> = {
  cache:  'cache',
  yahoo:  'fallback', // @deprecated marker
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
  // Kite is the live primary; Yahoo / cache / DB are fallbacks.
  const primarySource: ProviderSource = 'kite';
  if (source === primarySource && trail.every(t => t.ok || t.source !== primarySource)) return null;
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
  /^(circuit open for |db repo not registered$|no row for symbol$|no series for symbol$|no movers$|no intel for symbol$|KiteAdapter: unsupported feature)/i;
const silencedAt: Map<string, number> = new Map();
const SILENCE_WINDOW_MS = 60_000;

/** True for Kite errors that MUST cascade rather than crash the request. */
function isRecoverableKiteError(err: unknown): boolean {
  return (
    err instanceof UnsupportedFeatureError
    || err instanceof KiteAuthenticationError
    || err instanceof KiteRateLimitError
  );
}

function logProviderEvent(
  event: string,
  meta: Record<string, unknown>,
): void {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[PROVIDER] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

async function tryStep<T>(
  source: ProviderSource,
  trail: AttemptLog[],
  fn: () => Promise<T>,
): Promise<T | null> {
  const started = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - started;
    trail.push({ source, ok: true, ms });
    silencedAt.delete(source);
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - started;
    trail.push({ source, ok: false, error: message, ms });

    // Recoverable Kite failures are expected during dual-run — log once
    // at info so soak tests can grep without treating them as hard errors.
    if (source === 'kite' && isRecoverableKiteError(err)) {
      logProviderEvent('kite_recoverable_fail', {
        source,
        latency_ms: ms,
        error: message.slice(0, 160),
        fallback: 'next',
      });
      return null;
    }

    if (KNOWN_FAILURE_RE.test(message)) {
      const now = Date.now();
      const last = silencedAt.get(source) ?? 0;
      if (now - last >= SILENCE_WINDOW_MS) {
        log.warn('provider step failed (suppressing repeats for 60s)', { source, error: message, latency_ms: ms });
        silencedAt.set(source, now);
      }
    } else {
      log.warn('provider step failed', { source, error: message, latency_ms: ms });
    }
    return null;
  }
}

// ── getLiveSnapshot / getQuote ──────────────────────────────────────
//
// Fallback chain (Phase 1): Kite → Cache → Yahoo → PostgreSQL
//
export async function getLiveSnapshot(
  symbol: string,
  opts: GetOptions = {},
): Promise<ProviderResponse<MarketSnapshot>> {
  const sym = symbol.trim().toUpperCase();
  const key = quoteCacheKey(sym);
  const trail: AttemptLog[] = [];
  const marketOpen = isMarketOpen();
  const selected = getMarketDataProvider();
  const startedAt = Date.now();
  const capability: ProviderCapabilityTag = 'quotes';

  logProviderEvent('request', {
    method: 'getLiveSnapshot',
    selected,
    fallback_provider: getPrimaryFallbackProvider(selected),
    capability,
    symbol: sym,
  });

  // ── 1. Kite ─────────────────────────────────────────────────────
  logProviderEvent('attempt', {
    provider: 'kite',
    method: 'getQuote',
    capability,
    symbol: sym,
  });
  const kiteHit = await tryStep('kite', trail, () =>
    withProviderFrame(() =>
      guarded('kite', () => Kite.getQuote(sym), { timeoutMs: 5000, attempts: 2 }),
    ),
  );
  if (kiteHit) {
    logProviderEvent('success', {
      provider: 'kite',
      selected,
      fallback_provider: 'none',
      capability,
      latency_ms: Date.now() - startedAt,
      symbol: sym,
    });
    await cache.set(key, kiteHit, QUOTE_TTL_S);
    void propagateTick(kiteHit);
    return rejectIfStale(
      wrap(kiteHit, 'kite', 'near-live', trail),
      !!opts.signalCritical,
    );
  }
  logProviderEvent('fallback', {
    from: 'kite',
    to: 'cache|yahoo|db',
    reason: 'kite_miss_or_error',
    capability,
    symbol: sym,
    latency_ms: Date.now() - startedAt,
  });

  // ── 2. Cache ────────────────────────────────────────────────────
  if (!opts.forceRefresh) {
    const cached = await cache.get<MarketSnapshot>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      logProviderEvent('success', {
        provider: 'cache',
        selected,
        fallback_provider: 'kite→cache',
        capability,
        latency_ms: Date.now() - startedAt,
        symbol: sym,
      });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  // ── 3. Yahoo ────────────────────────────────────────────────────
  if (yahooAllowed()) {
    logProviderEvent('attempt', { provider: 'yahoo', method: 'getQuote', symbol: sym });
    const yah = await tryStep('yahoo', trail, () =>
      withProviderFrame(() =>
        guarded('yahoo', () => Yahoo.getQuote(sym), { timeoutMs: 5000, attempts: 2 }),
      ),
    );
    if (yah) {
      logProviderEvent('success', {
        provider: 'yahoo',
        selected,
        fallback: 'yahoo',
        latency_ms: Date.now() - startedAt,
        symbol: sym,
      });
      await cache.set(key, yah, QUOTE_TTL_S);
      return rejectIfStale(
        wrap(yah, 'yahoo', marketOpen ? 'fallback-delayed' : 'stale', trail),
        !!opts.signalCritical,
      );
    }
    logProviderEvent('fail', { provider: 'yahoo', symbol: sym });
  }

  // ── 4. PostgreSQL stale last-resort ─────────────────────────────
  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getQuote) throw new Error('db repo not registered');
    const row = await dbRepo.getQuote(sym);
    if (!row) throw new Error('no row for symbol');
    return row;
  });
  if (dbHit) {
    logProviderEvent('success', {
      provider: 'db',
      selected,
      fallback: 'db',
      latency_ms: Date.now() - startedAt,
      symbol: sym,
    });
    return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);
  }

  logProviderEvent('exhausted', {
    selected,
    symbol: sym,
    latency_ms: Date.now() - startedAt,
  });
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
// CACHE-FIRST, then Kite → Yahoo → DB. Historical data is the biggest
// budget waster when callers re-request the same series inside its TTL.

export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
  opts: GetOptions = {},
): Promise<ProviderResponse<HistoricalSeries>> {
  const sym = symbol.trim().toUpperCase();
  const key = historicalCacheKey(sym, range);
  const trail: AttemptLog[] = [];
  const selected = getMarketDataProvider();
  const startedAt = Date.now();

  logProviderEvent('request', {
    method: 'getHistorical',
    selected,
    fallback_provider: getPrimaryFallbackProvider(selected),
    capability: 'historical',
    symbol: sym,
    range,
  });

  if (!opts.forceRefresh) {
    const cached = await cache.get<HistoricalSeries>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  logProviderEvent('attempt', {
    provider: 'kite',
    method: 'getHistorical',
    capability: 'historical',
    symbol: sym,
  });
  const kiteHit = await tryStep('kite', trail, () =>
    withProviderFrame(() => guarded('kite', () => Kite.getHistorical(sym, range))),
  );
  if (kiteHit && kiteHit.candles.length > 0) {
    logProviderEvent('success', {
      provider: 'kite',
      selected,
      fallback_provider: 'none',
      capability: 'historical',
      latency_ms: Date.now() - startedAt,
      symbol: sym,
    });
    await cache.set(key, kiteHit);
    return rejectIfStale(wrap(kiteHit, 'kite', 'near-live', trail), !!opts.signalCritical);
  }
  logProviderEvent('fallback', {
    from: 'kite',
    to: 'yahoo|db',
    reason: 'kite_miss_or_error',
    capability: 'historical',
    selected,
    fallback_provider: 'yahoo',
    symbol: sym,
    latency_ms: Date.now() - startedAt,
  });

  if (yahooAllowed()) {
    const yah = await tryStep('yahoo', trail, () =>
      withProviderFrame(() => guarded('yahoo', () => Yahoo.getHistorical(sym, range))),
    );
    if (yah && yah.candles.length > 0) {
      logProviderEvent('success', { provider: 'yahoo', selected, fallback: 'yahoo', symbol: sym });
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
// Kite → Yahoo → empty/db. (Phase 1 — primary vendor removed from search.)

export async function searchSymbols(query: string): Promise<ProviderResponse<SymbolSearchHit[]>> {
  const trail: AttemptLog[] = [];
  const selected = getMarketDataProvider();
  logProviderEvent('request', {
    method: 'searchSymbols',
    selected,
    fallback_provider: getPrimaryFallbackProvider(selected),
    capability: 'search',
    query: query.slice(0, 40),
  });

  const kiteHit = await tryStep('kite', trail, () =>
    withProviderFrame(() => guarded('kite', () => Kite.searchSymbol(query))),
  );
  if (kiteHit && kiteHit.length > 0) {
    logProviderEvent('success', {
      provider: 'kite',
      selected,
      fallback_provider: 'none',
      capability: 'search',
    });
    return wrap(kiteHit, 'kite', 'near-live', trail);
  }
  logProviderEvent('fallback', {
    from: 'kite',
    to: 'yahoo',
    reason: 'kite_miss_or_error',
    capability: 'search',
    selected,
    fallback_provider: 'yahoo',
  });

  if (yahooAllowed()) {
    const yah = await tryStep('yahoo', trail, () =>
      withProviderFrame(() => guarded('yahoo', () => Yahoo.searchSymbol(query))),
    );
    if (yah && yah.length > 0) return wrap(yah, 'yahoo', 'fallback-delayed', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ── getMovers ───────────────────────────────────────────────────────
// CACHE-FIRST, then rankings MySQL. Empty buckets are a valid 200.

const EMPTY_MOVERS: MoversResult = { gainers: [], losers: [], mostActive: [] };

async function fetchMoversFromRankings(limit = 50): Promise<MoversResult> {
  const mapRow = (r: { symbol?: string; ltp?: unknown; pct_change?: unknown }): MoversBucket => ({
    symbol: String(r.symbol ?? '').toUpperCase(),
    price: Number(r.ltp) || 0,
    changePercent: Number(r.pct_change) || 0,
  });
  const valid = (b: MoversBucket) =>
    Boolean(b.symbol) && Number.isFinite(b.price) && b.price > 0;

  try {
    const [gainersRes, losersRes, activeRes] = await Promise.all([
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE pct_change IS NOT NULL AND pct_change > 0
          ORDER BY pct_change DESC
          LIMIT ?`,
        [limit],
      ),
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE pct_change IS NOT NULL AND pct_change < 0
          ORDER BY pct_change ASC
          LIMIT ?`,
        [limit],
      ),
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE volume IS NOT NULL AND volume > 0
          ORDER BY volume DESC
          LIMIT ?`,
        [limit],
      ),
    ]);
    return {
      gainers:    gainersRes.rows.map(mapRow).filter(valid),
      losers:     losersRes.rows.map(mapRow).filter(valid),
      mostActive: activeRes.rows.map(mapRow).filter(valid),
    };
  } catch (err) {
    log.warn('rankings movers query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...EMPTY_MOVERS };
  }
}

export async function getMovers(opts: GetOptions = {}): Promise<ProviderResponse<MoversResult>> {
  const key = moversCacheKey();
  const trail: AttemptLog[] = [];
  const selected = getMarketDataProvider();

  if (!opts.forceRefresh) {
    const cached = await cache.get<MoversResult>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
    const redisCached = await redisCacheGet<MoversResult>(key);
    if (redisCached) {
      await cache.set(key, redisCached, MOVERS_TTL_S);
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(redisCached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  // Kite has no movers — record UnsupportedFeatureError then rankings.
  if (selected === 'kite' || isKitePrimary()) {
    logProviderEvent('attempt', {
      provider: 'kite',
      method: 'getMovers',
      capability: 'movers',
    });
    await tryStep('kite', trail, () =>
      withProviderFrame(() => guarded('kite', () => Kite.getMovers())),
    );
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'db',
      reason: 'unsupported_capability',
      capability: 'movers',
      selected,
      fallback_provider: 'rankings',
    });
  }

  const rankingsHit = await tryStep('db', trail, async () => {
    const row = await fetchMoversFromRankings();
    if (!row.gainers.length && !row.losers.length && !row.mostActive.length) {
      throw new Error('no movers');
    }
    return row;
  });
  if (rankingsHit) {
    logProviderEvent('success', {
      provider: 'db',
      selected,
      fallback_provider: 'rankings',
      capability: 'movers',
    });
    await cache.set(key, rankingsHit, MOVERS_TTL_S);
    await redisCacheSet(key, rankingsHit, MOVERS_TTL_S);
    return rejectIfStale(wrap(rankingsHit, 'db', 'stale', trail), !!opts.signalCritical);
  }

  const dbHit = await tryStep('db', trail, async () => {
    if (!dbRepo.getMovers) throw new Error('db repo not registered');
    const row = await dbRepo.getMovers();
    if (!row) throw new Error('no movers');
    return row;
  });
  if (dbHit) return rejectIfStale(wrap(dbHit, 'db', 'stale', trail), !!opts.signalCritical);

  // Empty movers is a valid response — callers / HTTP route return 200 + [].
  return rejectIfStale(wrap(EMPTY_MOVERS, 'db', 'stale', trail), !!opts.signalCritical);
}

// ── getCorporateIntel ───────────────────────────────────────────────
// CACHE-FIRST. Corporate data changes at most daily — 6-hour TTL.
// Live fill: Yahoo quoteSummary fundamentals.

function yahooToCorporateIntel(sym: string, y: Awaited<ReturnType<typeof fetchYahooFundamentals>>): CorporateIntel | null {
  if (!y) return null;
  return {
    symbol: sym,
    companyName: y.companyName ?? sym,
    sector:   y.sector ?? undefined,
    industry: y.industry ?? undefined,
    marketCap:     y.marketCap ?? undefined,
    pe:            y.pe ?? undefined,
    eps:           y.eps ?? undefined,
    dividendYield: y.dividendYield ?? undefined,
    bookValue:     y.bookValue ?? undefined,
    roe:           y.roe ?? undefined,
    debtToEquity:  y.debtToEquity ?? undefined,
  };
}

function yahooToFundamentals(sym: string, y: Awaited<ReturnType<typeof fetchYahooFundamentals>>): Fundamentals | null {
  if (!y) return null;
  return {
    symbol: sym,
    companyName: y.companyName ?? sym,
    pe:            y.pe ?? undefined,
    pb:            y.pbRatio ?? undefined,
    roe:           y.roe ?? undefined,
    debtToEquity:  y.debtToEquity ?? undefined,
    dividendYield: y.dividendYield ?? undefined,
    asOf: Date.now(),
  };
}

export async function getCorporateIntel(
  symbol: string,
  opts: GetOptions = {},
): Promise<ProviderResponse<CorporateIntel>> {
  const sym = symbol.trim().toUpperCase();
  const key = corporateIntelCacheKey(sym);
  const trail: AttemptLog[] = [];
  const selected = getMarketDataProvider();

  if (!opts.forceRefresh) {
    const cached = await cache.get<CorporateIntel>(key);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  if (selected === 'kite' || isKitePrimary()) {
    logProviderEvent('attempt', {
      provider: 'kite',
      method: 'getCorporateIntel',
      capability: 'corporate',
      symbol: sym,
    });
    await tryStep('kite', trail, () =>
      withProviderFrame(() => guarded('kite', () => Kite.getCorporateIntel(sym))),
    );
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'yahoo',
      reason: 'unsupported_capability',
      capability: 'corporate',
      selected,
      fallback_provider: 'yahoo',
      symbol: sym,
    });
  }

  if (yahooAllowed()) {
    const yah = await tryStep('yahoo', trail, async () => {
      const raw = await fetchYahooFundamentals(sym);
      const mapped = yahooToCorporateIntel(sym, raw);
      if (!mapped) throw new Error('no yahoo fundamentals');
      return mapped;
    });
    if (yah) {
      logProviderEvent('success', {
        provider: 'yahoo',
        selected,
        fallback_provider: 'yahoo',
        capability: 'corporate',
        symbol: sym,
      });
      await cache.set(key, yah);
      await redisCacheSet(key, yah, CORP_TTL_S);
      await redisCacheSet(`corp:stale:${sym}`, yah, 7 * 24 * 60 * 60);
      return rejectIfStale(wrap(yah, 'yahoo', 'fallback-delayed', trail), !!opts.signalCritical);
    }
  }

  const staleRedis = await redisCacheGet<CorporateIntel>(`corp:stale:${sym}`);
  if (staleRedis) {
    trail.push({ source: 'cache', ok: true });
    return rejectIfStale(wrap(staleRedis, 'cache', 'stale', trail), !!opts.signalCritical);
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
  const selected = getMarketDataProvider();
  const fundKey = `fundamentals:${sym}`;

  if (!opts.forceRefresh) {
    const cached = await redisCacheGet<Fundamentals>(fundKey);
    if (cached) {
      trail.push({ source: 'cache', ok: true });
      return rejectIfStale(wrap(cached, 'cache', 'cached-fresh', trail), !!opts.signalCritical);
    }
  }

  if (selected === 'kite' || isKitePrimary()) {
    logProviderEvent('attempt', {
      provider: 'kite',
      method: 'getFundamentals',
      capability: 'fundamentals',
      symbol: sym,
    });
    await tryStep('kite', trail, () =>
      withProviderFrame(() => guarded('kite', () => Kite.getFundamentals(sym))),
    );
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'yahoo',
      reason: 'unsupported_capability',
      capability: 'fundamentals',
      selected,
      fallback_provider: 'yahoo',
      symbol: sym,
    });
  }

  if (yahooAllowed()) {
    const yah = await tryStep('yahoo', trail, async () => {
      const raw = await fetchYahooFundamentals(sym);
      const mapped = yahooToFundamentals(sym, raw);
      if (!mapped) throw new Error('no yahoo fundamentals');
      return mapped;
    });
    if (yah) {
      logProviderEvent('success', {
        provider: 'yahoo',
        selected,
        fallback_provider: 'yahoo',
        capability: 'fundamentals',
        symbol: sym,
      });
      await redisCacheSet(fundKey, yah, CORP_TTL_S);
      await redisCacheSet(`fund:stale:${sym}`, yah, 7 * 24 * 60 * 60);
      return rejectIfStale(wrap(yah, 'yahoo', 'fallback-delayed', trail), !!opts.signalCritical);
    }
  }

  const staleFund = await redisCacheGet<Fundamentals>(`fund:stale:${sym}`);
  if (staleFund) {
    trail.push({ source: 'cache', ok: true });
    return rejectIfStale(wrap(staleFund, 'cache', 'stale', trail), !!opts.signalCritical);
  }

  throw new StaleDataError(wrap({ symbol: sym, companyName: sym, asOf: 0 } as Fundamentals, 'db', 'stale', trail));
}

// ── getIndustryPeers ────────────────────────────────────────────────

/**
 * Industry peers endpoint is unavailable — return empty. Callers already
 * treat `[]` as "no peers known".
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
// Chain: Cache → Kite → Yahoo → DB (Phase 1).
// On success, EACH snapshot is written to the per-symbol cache key
// (quote:<SYMBOL>). Downstream consumers that read via
// getLiveSnapshot() see the batch result as a cache hit within TTL —
// no call-site changes needed.

export interface BatchSnapshotEntry {
  symbol: string;
  snapshot: MarketSnapshot | null;
  source: ProviderSource;     // 'kite' | 'yahoo' | 'cache' | 'db'
  data_quality: DataQuality;
}

export interface BatchSnapshotResult {
  entries: BatchSnapshotEntry[];
  /** number of upstream batch requests actually issued */
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

  // 1. Cache-first per symbol.
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

  const estimatedCalls = misses.length;
  const batchCallsMade = estimatedCalls;

  const snapBySymbol = new Map<string, { snap: MarketSnapshot; source: ProviderSource }>();
  let stillMissing = [...misses];

  // 3. Kite batch
  logProviderEvent('attempt', {
    provider: 'kite',
    method: 'getBatchQuotes',
    symbols: stillMissing.length,
  });
  try {
    const kiteBatch = await withProviderFrame(() =>
      guarded(
        'kite',
        () => Kite.getBatchQuotes(stillMissing),
        { timeoutMs: 60000, attempts: 1 },
      ),
    );
    for (const snap of kiteBatch.snapshots) {
      snapBySymbol.set(snap.symbol.toUpperCase(), { snap, source: 'kite' });
    }
    stillMissing = kiteBatch.missing.length > 0
      ? kiteBatch.missing
      : stillMissing.filter(s => !snapBySymbol.has(s));
    logProviderEvent('success', {
      provider: 'kite',
      method: 'getBatchQuotes',
      returned: kiteBatch.snapshots.length,
      missing: stillMissing.length,
    });
  } catch (err) {
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'yahoo',
      reason: err instanceof Error ? err.message.slice(0, 120) : 'error',
      capability: 'batch_quotes',
      selected: 'kite',
      fallback_provider: 'yahoo',
    });
  }

  // 4. Yahoo for symbols still missing after Kite
  if (stillMissing.length > 0 && yahooAllowed()) {
    logProviderEvent('attempt', {
      provider: 'yahoo',
      method: 'getBatchQuotes',
      symbols: stillMissing.length,
    });
    try {
      const yahooSnaps = await withProviderFrame(() =>
        guarded(
          'yahoo',
          () => Yahoo.fetchYahooQuotesBatch(stillMissing),
          { timeoutMs: 60000, attempts: 1 },
        ),
      );
      for (const snap of yahooSnaps) {
        const key = snap.symbol.toUpperCase();
        if (!snapBySymbol.has(key)) {
          snapBySymbol.set(key, { snap, source: 'yahoo' });
        }
      }
      stillMissing = stillMissing.filter(s => !snapBySymbol.has(s));
      logProviderEvent('success', {
        provider: 'yahoo',
        method: 'getBatchQuotes',
        returned: yahooSnaps.length,
        missing: stillMissing.length,
      });
    } catch (err) {
      log.warn('yahoo batch quote call failed — falling back to stale for misses', {
        error: err instanceof Error ? err.message : String(err),
        symbols: stillMissing.length,
      });
    }
  }

  // 5. Fan successful rows out to the per-symbol cache.
  for (const { snap, source } of snapBySymbol.values()) {
    await cache.set(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    await redisCacheSet(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
    void propagateTick(snap);
    entries.push({
      symbol: snap.symbol,
      snapshot: snap,
      source,
      data_quality: source === 'yahoo' ? 'fallback-delayed' : 'near-live',
    });
  }
  for (const sym of stillMissing) {
    entries.push({ symbol: sym, snapshot: null, source: 'db', data_quality: 'stale' });
  }

  return {
    entries,
    batchCallsMade,
    missingAfterBatch: stillMissing,
  };
}

// ── getTrendingSymbols / getPriceShockers / getNseMostActive ────────
// Cache-first discovery. Upstream discovery endpoints are retired —
// empty arrays are valid so the scheduler can keep calling these.

export async function getTrendingSymbols(): Promise<ProviderResponse<string[]>> {
  const key = trendingCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<string[]>(key)
    ?? await redisCacheGet<string[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getPriceShockers(): Promise<ProviderResponse<string[]>> {
  const key = shockersCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<string[]>(key)
    ?? await redisCacheGet<string[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getNseMostActive(): Promise<ProviderResponse<MoversBucket[]>> {
  const key = nseMostActiveCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<MoversBucket[]>(key)
    ?? await redisCacheGet<MoversBucket[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

// ── News ────────────────────────────────────────────────────────────
// Cache / stale only — live news is served by RSS / GNews / news-engine.

export async function getMarketNews(): Promise<ProviderResponse<NewsItem[]>> {
  const key = marketNewsCacheKey();
  const trail: AttemptLog[] = [];

  const cached = await cache.get<NewsItem[]>(key)
    ?? await redisCacheGet<NewsItem[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }
  return wrap([], 'db', 'stale', trail);
}

export async function getCompanyNews(symbol: string): Promise<ProviderResponse<NewsItem[]>> {
  const sym = symbol.trim().toUpperCase();
  const key = companyNewsCacheKey(sym);
  const trail: AttemptLog[] = [];

  const cached = await cache.get<NewsItem[]>(key)
    ?? await redisCacheGet<NewsItem[]>(key);
  if (cached) {
    trail.push({ source: 'cache', ok: true });
    return wrap(cached, 'cache', 'cached-fresh', trail);
  }

  const staleNews = await redisCacheGet<NewsItem[]>(`news:stale:${sym}`);
  if (staleNews?.length) {
    trail.push({ source: 'cache', ok: true });
    return wrap(staleNews, 'cache', 'stale', trail);
  }

  // Empty — live company news is served by RSS / GNews / news-engine.
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
  getTrendingSymbols,
  getPriceShockers,
  getNseMostActive,
  getMarketNews,
  getCompanyNews,
};

export default MarketDataProvider;
