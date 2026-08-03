// ════════════════════════════════════════════════════════════════
//  MarketDataResolver — the SINGLE entry point every consumer uses
//  for live prices and batch snapshots.
//
//  Resolver order (Phase 1 decommission — Kite primary, no vendor API):
//    0. Market-closed gate — when NSE is closed, NO upstream call
//       runs (Kite, NSE direct, Yahoo are all skipped).
//       Returns cache hits if any, else `provider='snapshot'` +
//       `errorCode='MARKET_CLOSED'`.
//    1. Cache-first (skipped when forceRefresh=true)
//    2. Kite (always tried when not legacy / closed)
//    3. NSE direct rare fallback (only after consecutive primary
//       true-failures trip the configured threshold)
//    4. Yahoo emergency (only when YAHOO_EMERGENCY_FALLBACK_ENABLED)
//    → otherwise DATA_DEGRADED.
//
//  Cascade gate (spec §2): NSE direct + Yahoo run ONLY when the
//  primary failure is a TRUE failure (timeout / network / 5xx /
//  empty / invalid / Kite auth+rate-limit). 409, MARKET_CLOSED,
//  BUDGET_THROTTLED, BUDGET_EXHAUSTED, ROUTE_REMOVED do NOT cascade.
//
//  Hard rule: if the resolver returns dataQuality='LOW',
//  confirmed-signal generation MUST stop. The caller is responsible
//  for honouring the contract; the resolver only signals.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import type { MarketSnapshot } from '@/types/market';
import {
  fetchNseDirectQuotes,
  type NseDirectResult,
} from '../providers/nseDirectProvider';
import {
  cache,
  quoteCacheKey,
  QUOTE_TTL_S,
} from '@/lib/cache';
import { cacheGet as redisCacheGet } from '@/lib/redis';
import {
  isYahooEmergencyFallbackEnabled, // @deprecated marker
  getMarketDataProvider,
  getPrimaryFallbackProvider,
  isLegacyRollbackActive,
  getNseDirectFallbackConfig,
} from '../providerFlags';
import * as Kite from '@/providers/adapters/KiteAdapter';
import { UnsupportedFeatureError } from '@/providers/adapters/UnsupportedFeatureError';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';
import * as YahooEmergency from '@/providers/adapters/YahooAdapter'; // @deprecated marker
import { logFeedHealth } from '../feedHealthLog';
import { isMarketOpen, getMarketStatus } from '../marketHours';
import { isInNifty500 } from '../nifty500Universe';
import { recordProviderCall, updateLastError } from '../providerReport';
import { recordProviderLatency, recordFallback } from '@/lib/monitor/apiMonitor';
import {
  recordFallbackTriggered,
  recordFallbackSuccess,
  recordFallbackFailed,
} from '@/lib/monitor/institutionalHealth';

const log = logger.child({ component: 'marketDataResolver' });

// ── Local ProviderInvocation envelope (formerly re-exported) ───────

export type InvocationStatus = 'success' | 'partial' | 'failed' | 'degraded';
export type InvocationQuality = 'HIGH' | 'MEDIUM' | 'LOW';

/** Per-call envelope previously sourced from the removed primary vendor
 *  module. Kept here so consumers of `ProviderInvocation` keep compiling.
 *  `provider` is a free-form string (e.g. 'kite' | 'nse_direct'). */
export interface ProviderInvocation<T> {
  provider: string;
  endpoint: string;
  requestStartedAt:   string;
  responseReceivedAt: string;
  latencyMs:          number;
  status:             InvocationStatus;
  dataQuality:        InvocationQuality;
  symbolsRequested: number;
  symbolsReturned:  number;
  coveragePercent:  number;
  staleSymbols:  string[];
  failedSymbols: string[];
  freshnessScore: number;
  errorCode:    string | null;
  errorMessage: string | null;
  data: T | null;
}

// ── Public envelope ────────────────────────────────────────────────

export type ResolverProvider =
  | 'kite'
  | 'cache'
  | 'nse_direct'
  | 'yahoo_emergency' // @deprecated marker
  /** Market-closed path — caller serves last_close_signals /
   *  q365_market_close_snapshot from MySQL. The resolver itself never
   *  reads the snapshot table; it just signals "closed, do not call
   *  any upstream" with this provider value + errorCode='MARKET_CLOSED'. */
  | 'snapshot'
  | 'none';

export type ResolverStatus  = InvocationStatus;
export type ResolverQuality = InvocationQuality;

/** Per-row payload keyed by canonical `${exchange}:${symbol}` in
 *  `ResolverResult.data`. Each row records the provider that
 *  produced it so a partial-coverage response can mix sources
 *  (e.g. some rows from cache, some from Kite). */
export interface ResolverRow {
  ltp:       number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  timestamp: string;       // ISO UTC
  source:    ResolverProvider;
}

export interface ResolverResult {
  provider:           ResolverProvider;
  status:             ResolverStatus;
  dataQuality:        ResolverQuality;
  requestStartedAt:   string;
  responseReceivedAt: string;
  latencyMs:          number;

  symbolsRequested: number;
  symbolsReturned:  number;
  coveragePercent:  number;

  staleSymbols:  string[];
  failedSymbols: string[];

  errorCode:    string | null;
  errorMessage: string | null;

  /** True when the result came from a non-primary provider after the
   *  primary (Kite) was attempted and produced a TRUE failure
   *  (timeout / network / 5xx / empty / invalid). False when the
   *  primary served the request, when the cache served it without an
   *  upstream attempt, or when a non-true primary outcome (409,
   *  internal-engine block, MARKET_CLOSED, BUDGET_*) suppressed the
   *  cascade per spec. */
  fallbackUsed: boolean;

  /** Snapshots keyed by symbol. Kept for backwards compatibility
   *  with callers written against the original resolver shape. New
   *  code should read `data` instead — it's keyed by canonical
   *  `${exchange}:${symbol}` and exposes the per-row source. */
  snapshots: Map<string, MarketSnapshot>;

  /** Spec-aligned per-row payload keyed by canonical
   *  `${exchange}:${symbol}`. Empty when nothing returned. */
  data: Record<string, ResolverRow>;
}

// ── Tracking: consecutive primary (Kite) failures (NSE trigger) ────

let consecutivePrimaryFailures = 0;

function notePrimaryOutcome(ok: boolean): void {
  consecutivePrimaryFailures = ok ? 0 : consecutivePrimaryFailures + 1;
}

export function getConsecutivePrimaryFailures(): number {
  return consecutivePrimaryFailures;
}

// ── Internal helpers ───────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function emptyResult(opts: {
  provider:    ResolverProvider;
  status:      ResolverStatus;
  errorCode:   string | null;
  errorMessage: string | null;
  symbolsAsked: string[];
  startedAt:   string;
  startTs:     number;
  fallbackUsed?: boolean;
}): ResolverResult {
  const responseReceivedAt = nowIso();
  return {
    provider: opts.provider,
    status:   opts.status,
    dataQuality: 'LOW',
    requestStartedAt: opts.startedAt,
    responseReceivedAt,
    latencyMs: Date.now() - opts.startTs,
    symbolsRequested: opts.symbolsAsked.length,
    symbolsReturned:  0,
    coveragePercent:  0,
    staleSymbols:     [],
    failedSymbols:    [...opts.symbolsAsked],
    errorCode:        opts.errorCode,
    errorMessage:     opts.errorMessage,
    fallbackUsed:     opts.fallbackUsed ?? false,
    snapshots:        new Map(),
    data:             {},
  };
}

/** Spec §5 logging — one line per resolved batch describing which
 *  provider served the data, whether a fallback was triggered, and
 *  why. Operators grep on `RESOLVER_OUTCOME` to audit fallback
 *  behaviour without reading every per-call feed-health row. */
function logResolverOutcome(
  symbolsAsked: number,
  result: ResolverResult,
  failureReason: string | null,
): void {
  log.info('RESOLVER_OUTCOME', {
    provider_used:       result.provider,
    selected:            getMarketDataProvider(),
    fallback_provider:   getPrimaryFallbackProvider(),
    fallback_triggered:  result.fallbackUsed,
    failure_reason:      failureReason,
    capability:          'batch_quotes',
    status:              result.status,
    data_quality:        result.dataQuality,
    symbols_requested:   symbolsAsked,
    symbols_returned:    result.symbolsReturned,
    coverage_percent:    result.coveragePercent,
    latency_ms:          result.latencyMs,
    error_code:          result.errorCode,
  });
}

/** Same `[PROVIDER]` console format as MarketDataProvider (Phase 4). */
function logProviderEvent(
  event: string,
  meta: Record<string, unknown>,
): void {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[PROVIDER] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

function isRecoverableKiteError(err: unknown): boolean {
  return (
    err instanceof UnsupportedFeatureError
    || err instanceof KiteAuthenticationError
    || err instanceof KiteRateLimitError
  );
}

interface KiteBatchAttempt {
  ok: boolean;
  snapshots: MarketSnapshot[];
  missing: string[];
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  recoverable: boolean;
}

/** Invoke KiteAdapter.getBatchQuotes; never throws — maps failures
 *  into a recoverable/true-failure verdict for the cascade ladder. */
async function tryKiteBatchQuotes(symbols: string[]): Promise<KiteBatchAttempt> {
  const t0 = Date.now();
  try {
    const batch = await Kite.getBatchQuotes(symbols);
    const snaps = (batch.snapshots ?? []).filter(
      (s) => Number.isFinite(s.price) && s.price > 0,
    );
    return {
      ok: snaps.length > 0,
      snapshots: snaps,
      missing: batch.missing ?? [],
      errorCode: snaps.length === 0 ? 'KITE_EMPTY' : null,
      errorMessage: snaps.length === 0 ? 'Kite batch returned no priced snapshots' : null,
      latencyMs: Date.now() - t0,
      recoverable: snaps.length === 0,
    };
  } catch (err) {
    const recoverable = isRecoverableKiteError(err);
    const name = err instanceof Error ? err.name : 'KiteError';
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      snapshots: [],
      missing: symbols,
      errorCode: name,
      errorMessage: message,
      latencyMs: Date.now() - t0,
      recoverable,
    };
  }
}

function snapshotsToMap(arr: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const m = new Map<string, MarketSnapshot>();
  for (const s of arr) m.set(s.symbol.toUpperCase(), s);
  return m;
}

/** Build the canonical-key `data` record from a snapshots map.
 *  Defaults the exchange to NSE — the only exchange the current
 *  codebase resolves through this path. The day a BSE-only batch
 *  goes through, pass exchange='BSE'. */
function snapshotsToDataRecord(
  snapshots: MarketSnapshot[],
  source: ResolverProvider,
  exchange: 'NSE' | 'BSE' = 'NSE',
): Record<string, ResolverRow> {
  const out: Record<string, ResolverRow> = {};
  for (const s of snapshots) {
    const sym = s.symbol.toUpperCase();
    out[`${exchange}:${sym}`] = {
      ltp:       Number.isFinite(s.price) ? s.price : 0,
      open:      Number.isFinite(s.open) ? s.open : 0,
      high:      Number.isFinite(s.high) ? s.high : 0,
      low:       Number.isFinite(s.low) ? s.low : 0,
      close:     Number.isFinite(s.prevClose) ? s.prevClose : 0,
      volume:    Number.isFinite(s.volume) ? s.volume : 0,
      timestamp: new Date(Number.isFinite(s.timestamp) && s.timestamp > 0
                            ? s.timestamp
                            : Date.now()).toISOString(),
      source,
    };
  }
  return out;
}

/**
 * Data-quality classifier (Step 4 table, relaxed per spec
 * "RELAX DATA QUALITY" §4):
 *   HIGH   : coverage > 90% AND latency < 2000 ms AND freshness < 60 s
 *   MEDIUM : coverage ≥ 70% AND latency < 5000 ms AND freshness < 180 s
 *   LOW    : anything else (including the 50–70% partial-coverage band)
 *
 * `freshnessMs` should be the age of the data the upstream returned.
 * For per-call resolver hops we approximate it as the call latency
 * (the oldest a fresh fetch can be); cache hits pass the cached row's
 * own age. When the upstream doesn't expose a per-row timestamp we
 * fall back to latency, so this is a conservative classifier.
 */
function classifyResolverQuality(
  coveragePercent: number,
  latencyMs:       number,
  freshnessMs:     number,
): ResolverQuality {
  if (coveragePercent >  90 && latencyMs < 2_000  && freshnessMs < 60_000)  return 'HIGH';
  if (coveragePercent >= 70 && latencyMs < 5_000  && freshnessMs < 180_000) return 'MEDIUM';
  return 'LOW';
}

// ── Cache layer ────────────────────────────────────────────────────

async function readCacheBatch(symbols: string[]): Promise<{
  hits: MarketSnapshot[];
  misses: string[];
}> {
  const hits: MarketSnapshot[] = [];
  const misses: string[] = [];
  await Promise.all(symbols.map(async (sym) => {
    // In-process tier first, then Redis — cross-process writers (the
    // IndianAPI ingestion orchestrator, batch tier in another worker)
    // publish quote:<SYMBOL> via Redis.
    const v = await cache.get<MarketSnapshot>(quoteCacheKey(sym))
      ?? await redisCacheGet<MarketSnapshot>(quoteCacheKey(sym));
    if (v && Number.isFinite(v.price) && v.price > 0) hits.push(v);
    else misses.push(sym);
  }));
  return { hits, misses };
}

/** Build a resolver envelope from a 100% cache hit. Single feed-health
 *  row tagged provider='cache'. */
function assembleResultFromCache(
  hits: MarketSnapshot[],
  symbols: string[],
  startedAt: string,
  startTs: number,
  opts: ResolveOpts,
): ResolverResult {
  const responseReceivedAt = nowIso();
  const latencyMs = Date.now() - startTs;
  const coverage = symbols.length > 0
    ? Math.round((hits.length / symbols.length) * 100)
    : 0;
  const dq = classifyResolverQuality(coverage, latencyMs, latencyMs);
  if (!opts.quiet) {
    void logFeedHealth({
      provider: 'cache',
      endpoint: 'quote_cache',
      request_started_at: startedAt,
      response_received_at: responseReceivedAt,
      status: 'success',
      latency_ms: latencyMs,
      symbols_requested: symbols.length,
      symbols_returned: hits.length,
      coverage_percent: coverage,
      data_quality: dq,
      error_code: null,
      error_message: null,
    });
  }
  return {
    provider: 'cache',
    status: 'success',
    dataQuality: dq,
    requestStartedAt: startedAt,
    responseReceivedAt,
    latencyMs,
    symbolsRequested: symbols.length,
    symbolsReturned: hits.length,
    coveragePercent: coverage,
    staleSymbols: [],
    failedSymbols: [],
    errorCode: null,
    errorMessage: null,
    fallbackUsed: false,
    snapshots: snapshotsToMap(hits),
    data: snapshotsToDataRecord(hits, 'cache'),
  };
}

/** Build a resolver envelope when some symbols came from cache and
 *  some came from a fresh upstream call. Per-row provenance is
 *  preserved via the `data` record's per-row `source` field. */
function mergeResultFromCacheAndApi(
  cacheHits: MarketSnapshot[],
  freshSnaps: MarketSnapshot[],
  symbols: string[],
  inv: { status: ResolverStatus; latencyMs: number; failedSymbols: string[] },
  startedAt: string,
  startTs: number,
  apiProvider: ResolverProvider = 'kite',
): ResolverResult {
  const responseReceivedAt = nowIso();
  const latencyMs = Date.now() - startTs;
  const allRows = [...cacheHits, ...freshSnaps];
  const coverage = symbols.length > 0
    ? Math.round((allRows.length / symbols.length) * 100)
    : 0;
  const dq = classifyResolverQuality(coverage, latencyMs, latencyMs);
  const status: ResolverStatus =
    inv.failedSymbols.length === 0 && allRows.length === symbols.length
      ? 'success' : 'partial';
  void logFeedHealth({
    provider: apiProvider,
    endpoint: apiProvider === 'kite' ? 'kite:batch_quote:miss-fill' : 'nse/batch_quote:miss-fill',
    request_started_at: startedAt,
    response_received_at: responseReceivedAt,
    status,
    latency_ms: latencyMs,
    symbols_requested: symbols.length,
    symbols_returned: allRows.length,
    coverage_percent: coverage,
    data_quality: dq,
    error_code: null,
    error_message: null,
  });
  // Per-row source: cache rows come back as 'cache', fresh rows as apiProvider.
  const data: Record<string, ResolverRow> = {};
  Object.assign(data, snapshotsToDataRecord(cacheHits, 'cache'));
  Object.assign(data, snapshotsToDataRecord(freshSnaps, apiProvider));
  return {
    provider: apiProvider,
    status,
    dataQuality: dq,
    requestStartedAt: startedAt,
    responseReceivedAt,
    latencyMs,
    symbolsRequested: symbols.length,
    symbolsReturned: allRows.length,
    coveragePercent: coverage,
    staleSymbols: [],
    failedSymbols: inv.failedSymbols,
    errorCode: null,
    errorMessage: null,
    fallbackUsed: apiProvider !== 'kite',
    snapshots: snapshotsToMap(allRows),
    data,
  };
}

async function writeCacheBatch(snapshots: MarketSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map((s) =>
    cache.set(quoteCacheKey(s.symbol.toUpperCase()), s, QUOTE_TTL_S),
  ));
}

// ── Yahoo emergency layer ────────────────────────────────────────── // @deprecated marker

async function tryYahooEmergency(symbols: string[], signal?: AbortSignal): Promise<MarketSnapshot[]> { // @deprecated marker
  if (!isYahooEmergencyFallbackEnabled()) return []; // @deprecated marker
  const out: MarketSnapshot[] = [];
  for (const sym of symbols) {
    try {
      const yahoo = await YahooEmergency.fetchYahooQuotesBatch([sym], signal); // @deprecated marker
      if (yahoo && Number.isFinite(yahoo[0]?.price) && yahoo[0].price > 0) out.push(yahoo[0]);
    } catch {
      /* yahoo_removed — skip */ // @deprecated marker
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────

export interface ResolveOpts {
  forceRefresh?: boolean;
  quiet?: boolean;
  signal?: AbortSignal;
}

export async function resolveBatch(
  symbolsRaw: string[],
  opts: ResolveOpts = {},
): Promise<ResolverResult> {
  const signal = opts.signal;
  const cleanInput = [...new Set(
    symbolsRaw.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean),
  )];
  // Spec NIFTY500_LOCK_ENABLED §6 + §7: never fetch outside the
  // NIFTY 500 universe, even in fallback. Drop any non-member symbol
  // BEFORE the market-closed gate / cache reads / upstream calls.
  // Bypass via NIFTY500_LOCK=0 only — for one-off operator probes.
  const nifty500LockActive = process.env.NIFTY500_LOCK !== '0';
  const symbols: string[] = [];
  const rejectedNonNifty500: string[] = [];
  for (const sym of cleanInput) {
    if (!nifty500LockActive || isInNifty500(sym)) symbols.push(sym);
    else rejectedNonNifty500.push(sym);
  }
  if (rejectedNonNifty500.length > 0) {
    log.warn('resolver dropped symbols outside NIFTY 500 universe', {
      requested: cleanInput.length,
      accepted: symbols.length,
      rejected: rejectedNonNifty500.length,
      sample: rejectedNonNifty500.slice(0, 5),
    });
  }
  const startedAt = nowIso();
  const startTs   = Date.now();

  if (symbols.length === 0) {
    const errorCode    = cleanInput.length > 0 ? 'NIFTY500_LOCK_REJECTED_ALL' : 'EMPTY_REQUEST';
    const errorMessage = cleanInput.length > 0
      ? `all ${cleanInput.length} requested symbols are outside the NIFTY 500 universe`
      : 'no symbols to resolve';
    const r = emptyResult({
      provider: 'none', status: 'failed',
      errorCode, errorMessage,
      symbolsAsked: cleanInput, startedAt, startTs,
    });
    logResolverOutcome(cleanInput.length, r, errorCode);
    return r;
  }

  // ── Legacy rollback kill-switch ───────────────────────────────
  // MARKET_DATA_PROVIDER=legacy short-circuits the resolver. The
  // empty result + 'legacy_rollback' feed-health row makes the
  // rollback loud — operators see a DATA DEGRADED state on the
  // dashboard rather than a quiet revert to old code. The legacy
  // path itself runs separately (the deprecated yahoo/kite stub // @deprecated marker
  // surface remains importable until the 30-day soak completes).
  if (isLegacyRollbackActive()) {
    void logFeedHealth({
      provider: 'legacy_rollback',
      endpoint: 'rollback',
      request_started_at: startedAt,
      response_received_at: nowIso(),
      status: 'degraded',
      latency_ms: Date.now() - startTs,
      symbols_requested: symbols.length,
      symbols_returned: 0,
      coverage_percent: 0,
      data_quality: 'LOW',
      error_code: 'LEGACY_ROLLBACK',
      error_message: 'MARKET_DATA_PROVIDER=legacy — live resolver disabled',
    });
    const r = emptyResult({
      provider: 'none', status: 'degraded',
      errorCode: 'LEGACY_ROLLBACK',
      errorMessage: 'MARKET_DATA_PROVIDER=legacy is active',
      symbolsAsked: symbols, startedAt, startTs,
    });
    logResolverOutcome(symbols.length, r, 'LEGACY_ROLLBACK');
    return r;
  }

  // ── Market-closed early gate (spec §1, FIRST PRIORITY) ───────
  // When the NSE cash session is closed:
  //   • DO NOT call Kite
  //   • DO NOT call NSE direct
  //   • DO NOT call Yahoo
  // The resolver returns either a 100% cache hit (when the per-symbol
  // quote cache still has fresh values from the last open session)
  // or an envelope with provider='snapshot' + errorCode='MARKET_CLOSED'.
  // The route layer (/api/signals) recognises MARKET_CLOSED and serves
  // last_close_signals + q365_market_close_snapshot from MySQL.
  //
  // Bypass via env MARKET_CLOSED_RESOLVER_GATE=0 only — this guard is
  // load-bearing for the spec; the operator must consciously disable it.
  const marketClosedGateActive = process.env.MARKET_CLOSED_RESOLVER_GATE !== '0';
  if (marketClosedGateActive && !isMarketOpen()) {
    // Spec §6 — explicit DB-snapshot trace tag. Operators grep on
    // `[PROVIDER] DB SNAPSHOT` to confirm the off-hours path took the
    // no-API branch. We never call NSE / Yahoo / Kite here.
    console.log('[PROVIDER] DB SNAPSHOT → no API call');
    const status = getMarketStatus();
    const { hits, misses } = await readCacheBatch(symbols);
    const responseReceivedAt = nowIso();
    const coverage = symbols.length > 0
      ? Math.round((hits.length / symbols.length) * 100)
      : 0;
    const provider: ResolverProvider = hits.length > 0 ? 'cache' : 'snapshot';
    const resultStatus: ResolverStatus =
      hits.length === symbols.length ? 'success'
        : hits.length > 0            ? 'partial'
        :                              'degraded';
    const result: ResolverResult = {
      provider,
      status: resultStatus,
      dataQuality: hits.length === symbols.length ? 'MEDIUM' : 'LOW',
      requestStartedAt: startedAt,
      responseReceivedAt,
      latencyMs: Date.now() - startTs,
      symbolsRequested: symbols.length,
      symbolsReturned: hits.length,
      coveragePercent: coverage,
      staleSymbols: [],
      failedSymbols: misses,
      errorCode: 'MARKET_CLOSED',
      errorMessage: `NSE cash session ${status.state} — resolver suppressed all upstream calls (caller should serve last_close_signals + market_close_snapshot)`,
      fallbackUsed: false,
      snapshots: snapshotsToMap(hits),
      data: snapshotsToDataRecord(hits, hits.length > 0 ? 'cache' : 'snapshot'),
    };
    if (!opts.quiet) {
      void logFeedHealth({
        provider: 'cache',
        endpoint: 'market_closed_gate',
        request_started_at: startedAt,
        response_received_at: responseReceivedAt,
        status: resultStatus === 'degraded' ? 'degraded' : resultStatus,
        latency_ms: result.latencyMs,
        symbols_requested: symbols.length,
        symbols_returned: hits.length,
        coverage_percent: coverage,
        data_quality: result.dataQuality,
        error_code: 'MARKET_CLOSED',
        error_message: status.label,
      });
    }
    logResolverOutcome(symbols.length, result, 'MARKET_CLOSED');
    // Spec §1 + §7 — counter bump for the off-hours snapshot path.
    recordProviderCall('snapshot', { fallback: false, error: null });
    recordProviderLatency({
      provider:    'snapshot',
      durationMs:  result.latencyMs,
      success:     true,
      symbolsCount: symbols.length,
    });
    return result;
  }

  // ── IndianAPI mode gate (ingestion-first architecture) ─────────
  // Serve path is cache-only: the ingestion orchestrator (batch tier)
  // is the sole IndianAPI caller and publishes quote:<SYMBOL> to
  // Redis. The resolver NEVER calls Kite / NSE direct / Yahoo in this
  // mode — an empty cache is a loud degraded envelope, not a hidden
  // provider switch.
  if (getMarketDataProvider() === 'indianapi') {
    const { hits, misses } = await readCacheBatch(symbols);
    if (hits.length === symbols.length) {
      logProviderEvent('success', {
        provider: 'cache',
        selected: 'indianapi',
        fallback: 'none',
        cache_hit: 'full',
        latency_ms: Date.now() - startTs,
      });
      const r = assembleResultFromCache(hits, symbols, startedAt, startTs, opts);
      logResolverOutcome(symbols.length, r, null);
      return r;
    }
    if (hits.length > 0) {
      const responseReceivedAt = nowIso();
      const coverage = Math.round((hits.length / symbols.length) * 100);
      const r: ResolverResult = {
        provider: 'cache',
        status: 'partial',
        dataQuality: 'LOW',
        requestStartedAt: startedAt,
        responseReceivedAt,
        latencyMs: Date.now() - startTs,
        symbolsRequested: symbols.length,
        symbolsReturned: hits.length,
        coveragePercent: coverage,
        staleSymbols: [],
        failedSymbols: misses,
        errorCode: null,
        errorMessage: null,
        fallbackUsed: false,
        snapshots: snapshotsToMap(hits),
        data: snapshotsToDataRecord(hits, 'cache'),
      };
      if (!opts.quiet) {
        void logFeedHealth({
          provider: 'cache',
          endpoint: 'indianapi_warehouse_cache',
          request_started_at: startedAt,
          response_received_at: responseReceivedAt,
          status: 'partial',
          latency_ms: r.latencyMs,
          symbols_requested: symbols.length,
          symbols_returned: hits.length,
          coverage_percent: coverage,
          data_quality: 'LOW',
          error_code: null,
          error_message: null,
        });
      }
      logResolverOutcome(symbols.length, r, null);
      return r;
    }
    const r = emptyResult({
      provider: 'none', status: 'degraded',
      errorCode: 'INDIANAPI_WAREHOUSE_EMPTY',
      errorMessage: 'MARKET_DATA_PROVIDER=indianapi — cache empty; check ingestion scheduler / [INDIANAPI_INGEST] logs',
      symbolsAsked: symbols, startedAt, startTs,
    });
    logResolverOutcome(symbols.length, r, 'INDIANAPI_WAREHOUSE_EMPTY');
    return r;
  }

  // Tracks whether the cascade (NSE direct → Yahoo) is allowed to
  // run after the primary block returns. Spec §2: only TRUE primary
  // failures (timeout / network / 5xx / empty / invalid) trigger
  // cascade; 409, MARKET_CLOSED, BUDGET_*, ROUTE_REMOVED do not.
  let cascadeAllowed = true;
  // Carries the failure-reason string from the primary block down to
  // the final outcome log. Null when the primary succeeded or wasn't
  // attempted (cache-first 100% hit).
  let primaryFailureReason: string | null = null;
  // The non-true error code is preserved so a degraded-with-no-cache
  // exit returns the original primary signal (e.g. HTTP_409) instead
  // of the generic DATA_DEGRADED. Lets callers distinguish "real
  // outage" from "primary explicitly refused".
  let suppressedErrorCode:    string | null = null;
  let suppressedErrorMessage: string | null = null;
  let kiteAttempted = false;
  const selected = getMarketDataProvider();

  logProviderEvent('request', {
    method: 'resolveBatch',
    selected,
    fallback_provider: getPrimaryFallbackProvider(selected),
    capability: 'batch_quotes',
    symbols: symbols.length,
  });

  // ── 0. Cache-first ────────────────────────────────────────────
  // Cache-first returns when fully warm, OR pays for ONLY the misses
  // when partially warm. Bypassed when forceRefresh=true.
  if (!opts.forceRefresh) {
    const { hits, misses } = await readCacheBatch(symbols);
    if (misses.length === 0 && hits.length === symbols.length) {
      logProviderEvent('success', {
        provider: 'cache',
        selected,
        fallback: 'none',
        cache_hit: 'full',
        latency_ms: Date.now() - startTs,
      });
      const r = assembleResultFromCache(hits, symbols, startedAt, startTs, opts);
      logResolverOutcome(symbols.length, r, null);
      return r;
    }
    if (hits.length > 0) {
      // Partial cache — fill ONLY the misses from Kite.
      kiteAttempted = true;
      logProviderEvent('attempt', {
        provider: 'kite',
        method: 'getBatchQuotes',
        symbols: misses.length,
        cache_hit: 'partial',
      });
      const kite = await tryKiteBatchQuotes(misses);
      recordProviderCall('kite', { fallback: false, error: null });
      recordProviderLatency({
        provider:     'kite',
        durationMs:   kite.latencyMs,
        success:      kite.ok,
        errorCode:    kite.errorCode,
        symbolsCount: misses.length,
      });
      if (kite.ok) {
        notePrimaryOutcome(true);
        logProviderEvent('success', {
          provider: 'kite',
          selected,
          fallback: 'none',
          latency_ms: kite.latencyMs,
          returned: kite.snapshots.length,
        });
        await writeCacheBatch(kite.snapshots);
        const r = mergeResultFromCacheAndApi(
          hits,
          kite.snapshots,
          symbols,
          {
            status: kite.missing.length === 0 ? 'success' : 'partial',
            latencyMs: kite.latencyMs,
            failedSymbols: kite.missing,
          },
          startedAt,
          startTs,
          'kite',
        );
        logResolverOutcome(symbols.length, r, null);
        return r;
      }
      notePrimaryOutcome(false);
      primaryFailureReason = kite.errorCode ?? 'KITE_ERROR';
      suppressedErrorCode = kite.errorCode;
      suppressedErrorMessage = kite.errorMessage;
      updateLastError(primaryFailureReason, 'kite');
      logProviderEvent('fallback', {
        from: 'kite',
        to: 'cache|nse|yahoo',
        reason: kite.errorCode,
        latency_ms: kite.latencyMs,
        recoverable: kite.recoverable,
      });
      logProviderEvent('fail', { provider: 'kite', reason: primaryFailureReason });
      // Continue to secondary cache / NSE / Yahoo ladder below.
    }
    // No cache hits at all — fall into the Kite primary block below.
  }

  // ── 1. Kite primary (always tried when not legacy/closed) ─────
  if (cascadeAllowed && !kiteAttempted) {
    kiteAttempted = true;
    logProviderEvent('attempt', {
      provider: 'kite',
      method: 'getBatchQuotes',
      capability: 'batch_quotes',
      symbols: symbols.length,
    });
    const kite = await tryKiteBatchQuotes(symbols);
    recordProviderCall('kite', { fallback: false, error: null });
    recordProviderLatency({
      provider:     'kite',
      durationMs:   kite.latencyMs,
      success:      kite.ok,
      errorCode:    kite.errorCode,
      symbolsCount: symbols.length,
    });
    if (kite.ok) {
      notePrimaryOutcome(true);
      const coverage = Math.round((kite.snapshots.length / symbols.length) * 100);
      const status: ResolverStatus =
        kite.missing.length === 0 && kite.snapshots.length === symbols.length
          ? 'success' : 'partial';
      await writeCacheBatch(kite.snapshots);
      const dq = classifyResolverQuality(coverage, kite.latencyMs, kite.latencyMs);
      logProviderEvent('success', {
        provider: 'kite',
        selected,
        fallback_provider: 'none',
        capability: 'batch_quotes',
        latency_ms: kite.latencyMs,
        coverage_pct: coverage,
      });
      const r: ResolverResult = {
        provider: 'kite',
        status,
        dataQuality: dq,
        requestStartedAt: startedAt,
        responseReceivedAt: nowIso(),
        latencyMs: kite.latencyMs,
        symbolsRequested: symbols.length,
        symbolsReturned: kite.snapshots.length,
        coveragePercent: coverage,
        staleSymbols: [],
        failedSymbols: kite.missing,
        errorCode: null,
        errorMessage: null,
        fallbackUsed: false,
        snapshots: snapshotsToMap(kite.snapshots),
        data: snapshotsToDataRecord(kite.snapshots, 'kite'),
      };
      if (!opts.quiet) {
        void logFeedHealth({
          provider: 'kite',
          endpoint: 'kite:batch_quote',
          request_started_at: startedAt,
          response_received_at: r.responseReceivedAt,
          status,
          latency_ms: kite.latencyMs,
          symbols_requested: symbols.length,
          symbols_returned: kite.snapshots.length,
          coverage_percent: coverage,
          data_quality: dq,
          error_code: null,
          error_message: null,
        });
      }
      logResolverOutcome(symbols.length, r, null);
      return r;
    }
    notePrimaryOutcome(false);
    primaryFailureReason = kite.errorCode ?? 'KITE_ERROR';
    suppressedErrorCode = kite.errorCode;
    suppressedErrorMessage = kite.errorMessage;
    updateLastError(primaryFailureReason, 'kite');
    // Recoverable Kite errors (auth / rate-limit / unsupported) and
    // empty batches all cascade to cache → NSE → Yahoo.
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'cache|nse|yahoo',
      reason: kite.errorCode,
      capability: 'batch_quotes',
      selected,
      fallback_provider: getPrimaryFallbackProvider(selected),
      latency_ms: kite.latencyMs,
      recoverable: kite.recoverable,
    });
    logProviderEvent('fail', { provider: 'kite', reason: primaryFailureReason });
  }

  // ── 2. Fresh cache hit ────────────────────────────────────────
  if (!opts.forceRefresh) {
    const { hits, misses } = await readCacheBatch(symbols);
    if (hits.length > 0) {
      const responseReceivedAt = nowIso();
      const coverage = Math.round((hits.length / symbols.length) * 100);
      const status: ResolverStatus = misses.length === 0 ? 'success' : 'partial';
      const result: ResolverResult = {
        provider: 'cache',
        status,
        dataQuality: misses.length === 0 ? 'MEDIUM' : 'LOW',
        requestStartedAt: startedAt,
        responseReceivedAt,
        latencyMs: Date.now() - startTs,
        symbolsRequested: symbols.length,
        symbolsReturned: hits.length,
        coveragePercent: coverage,
        staleSymbols: [],
        failedSymbols: misses,
        errorCode: null,
        errorMessage: null,
        fallbackUsed: false,
        snapshots: snapshotsToMap(hits),
        data: snapshotsToDataRecord(hits, 'cache'),
      };
      if (!opts.quiet) {
        void logFeedHealth({
          provider: 'cache',
          endpoint: 'quote_cache',
          request_started_at: startedAt,
          response_received_at: responseReceivedAt,
          status,
          latency_ms: result.latencyMs,
          symbols_requested: symbols.length,
          symbols_returned: hits.length,
          coverage_percent: coverage,
          data_quality: result.dataQuality,
          error_code: null,
          error_message: null,
        });
      }
      logResolverOutcome(symbols.length, result, primaryFailureReason);
      return result;
    }
  }

  // ── 3. NSE direct rare fallback ───────────────────────────────
  // Hard gate: only attempt NSE direct after the configured number
  // of consecutive primary failures (default 3, env override
  // NSE_DIRECT_FALLBACK_TRIGGER_FAILURES). One transient blip never
  // triggers the rare path. Spec §2: skipped entirely when the most
  // recent primary outcome was a non-true failure (409, MARKET_CLOSED,
  // BUDGET_*, ROUTE_REMOVED) — those signals do not justify reaching
  // for the rare-fallback chain.
  const nseCfg = getNseDirectFallbackConfig();
  if (
    cascadeAllowed
    && nseCfg.enabled
    && consecutivePrimaryFailures >= nseCfg.triggerFailures
  ) {
    log.warn('NSE direct fallback engaged', {
      consecutiveFailures: consecutivePrimaryFailures,
      triggerThreshold: nseCfg.triggerFailures,
      symbols: symbols.length,
    });
    // Spec §7 — explicit cascade-trigger trace. Fires only when the
    // primary classification produced a TRUE failure AND the rolling
    // failure counter has tripped the configured threshold (default 3).
    console.log('[ERROR] Kite failed → triggering NSE');
    // Spec §6 — provider trace tag for the NSE branch.
    console.log('[PROVIDER] NSE FALLBACK →', symbols.length);
    // Spec FALLBACK-CHAOS-2026-05 — canonical [FALLBACK_*] tag family.
    console.log('[FALLBACK_TRIGGERED]', {
      from_provider:        'kite',
      consecutive_failures: consecutivePrimaryFailures,
      trigger_threshold:    nseCfg.triggerFailures,
      symbols:              symbols.length,
      reason:               primaryFailureReason,
    });
    console.log('[FALLBACK_PROVIDER_SELECTED]', {
      to_provider: 'nse_direct',
      symbols:     symbols.length,
    });
    recordFallbackTriggered('kite');
    const nseStart = Date.now();
    const nse: NseDirectResult = await fetchNseDirectQuotes(symbols, signal);
    const nseDurationMs = Date.now() - nseStart;
    if (nse.snapshots.length > 0) {
      const responseReceivedAt = nowIso();
      const coverage = Math.round((nse.snapshots.length / symbols.length) * 100);
      const status: ResolverStatus = nse.failedSymbols.length === 0 ? 'success' : 'partial';
      void logFeedHealth({
        provider: 'nse_direct',
        endpoint: 'quote-equity',
        request_started_at: startedAt,
        response_received_at: responseReceivedAt,
        status,
        latency_ms: Date.now() - startTs,
        symbols_requested: symbols.length,
        symbols_returned: nse.snapshots.length,
        coverage_percent: coverage,
        data_quality: nse.snapshots.length === symbols.length ? 'MEDIUM' : 'LOW',
        error_code: nse.errorCode,
        error_message: nse.errorMessage,
      });
      const r: ResolverResult = {
        provider: 'nse_direct',
        status,
        dataQuality: nse.snapshots.length === symbols.length ? 'MEDIUM' : 'LOW',
        requestStartedAt: startedAt,
        responseReceivedAt,
        latencyMs: Date.now() - startTs,
        symbolsRequested: symbols.length,
        symbolsReturned: nse.snapshots.length,
        coveragePercent: coverage,
        staleSymbols: [],
        failedSymbols: nse.failedSymbols,
        errorCode: nse.errorCode,
        errorMessage: nse.errorMessage,
        fallbackUsed: true,
        snapshots: snapshotsToMap(nse.snapshots),
        data: snapshotsToDataRecord(nse.snapshots, 'nse_direct'),
      };
      logResolverOutcome(symbols.length, r, primaryFailureReason);
      console.log('[FALLBACK_SUCCESS]', {
        provider: 'nse_direct',
        coverage_pct: coverage,
        snapshots_returned: nse.snapshots.length,
        symbols_requested: symbols.length,
        latency_ms: nseDurationMs,
      });
      recordFallbackSuccess('nse_direct');
      // Spec §7 — NSE fallback success. Last_error keeps the
      // primary's failure reason so operators can see WHY the cascade
      // engaged, even though THIS hop served data.
      recordProviderCall('nse', { fallback: true, error: primaryFailureReason });
      recordProviderLatency({
        provider:     'nse',
        durationMs:   nseDurationMs,
        success:      true,
        errorCode:    nse.errorCode,
        fallback:     true,
        symbolsCount: symbols.length,
      });
      recordFallback({
        route:        'marketDataResolver',
        fromProvider: 'kite',
        toProvider:   'nse',
        errorCode:    primaryFailureReason,
      });
      return r;
    }
    log.warn('NSE direct fallback returned no data', {
      errorCode: nse.errorCode, errorMessage: nse.errorMessage,
    });
    console.warn('[FALLBACK_FAILED]', {
      provider:   'nse_direct',
      error_code: nse.errorCode ?? 'NSE_NO_DATA',
      error_message: nse.errorMessage ?? null,
      symbols:    symbols.length,
    });
    recordFallbackFailed('nse_direct', nse.errorCode ?? 'NSE_NO_DATA');
    // Spec §7 — record the NSE attempt (counter + last_error) so the
    // debug report reflects it even when the leg returned no data.
    recordProviderCall('nse', { fallback: true, error: nse.errorCode ?? 'NSE_NO_DATA' });
    recordProviderLatency({
      provider:     'nse',
      durationMs:   nseDurationMs,
      success:      false,
      errorCode:    nse.errorCode ?? 'NSE_NO_DATA',
      fallback:     true,
      symbolsCount: symbols.length,
    });
    // Spec §7 — NSE empty handoff to Yahoo. Logged here (inside the
    // cascade-allowed NSE block) so the trace shows up only when the
    // resolver actually reached the NSE step before falling further.
    console.log('[ERROR] NSE failed → triggering Yahoo');
  }

  // ── 4. Yahoo emergency (gated) ──────────────────────────────── // @deprecated marker
  // Same cascade gate as NSE direct — non-true primary signals do
  // not justify a Yahoo fallback either.
  if (cascadeAllowed && isYahooEmergencyFallbackEnabled()) { // @deprecated marker
    // Spec §6 — provider trace tag for the Yahoo emergency branch.
    console.log('[PROVIDER] Yahoo FALLBACK →', symbols.length);
    const yahooStart = Date.now();
    const ya = await tryYahooEmergency(symbols, signal); // @deprecated marker
    const yahooDurationMs = Date.now() - yahooStart;
    if (ya.length > 0) {
      const responseReceivedAt = nowIso();
      const coverage = Math.round((ya.length / symbols.length) * 100);
      const status: ResolverStatus = ya.length === symbols.length ? 'success' : 'partial';
      void logFeedHealth({
        provider: 'yahoo', // @deprecated marker
        endpoint: 'yahoo_emergency_quote', // @deprecated marker
        request_started_at: startedAt,
        response_received_at: responseReceivedAt,
        status,
        latency_ms: Date.now() - startTs,
        symbols_requested: symbols.length,
        symbols_returned: ya.length,
        coverage_percent: coverage,
        data_quality: 'LOW',
        error_code: null,
        error_message: null,
      });
      const r: ResolverResult = {
        provider: 'yahoo_emergency', // @deprecated marker
        status,
        dataQuality: 'LOW',
        requestStartedAt: startedAt,
        responseReceivedAt,
        latencyMs: Date.now() - startTs,
        symbolsRequested: symbols.length,
        symbolsReturned: ya.length,
        coveragePercent: coverage,
        staleSymbols: [],
        failedSymbols: symbols.filter((s) => !ya.find((y) => y.symbol === s)),
        errorCode: null,
        errorMessage: null,
        fallbackUsed: true,
        snapshots: snapshotsToMap(ya),
        data: snapshotsToDataRecord(ya, 'yahoo_emergency'), // @deprecated marker
      };
      logResolverOutcome(symbols.length, r, primaryFailureReason);
      // Spec §7 — Yahoo fallback success.
      recordProviderCall('yahoo', { fallback: true, error: primaryFailureReason });
      recordProviderLatency({
        provider:     'yahoo',
        durationMs:   yahooDurationMs,
        success:      true,
        fallback:     true,
        symbolsCount: symbols.length,
      });
      recordFallback({
        route:        'marketDataResolver',
        fromProvider: 'kite',
        toProvider:   'yahoo',
        errorCode:    primaryFailureReason,
      });
      return r;
    }
  }

  // ── 5. Nothing returned data ──────────────────────────────────
  // When the primary returned a non-true failure (cascade suppressed)
  // surface that exact code so callers can distinguish "real outage"
  // from "explicit refusal" — only collapse to DATA_DEGRADED when an
  // actual cascade ran and still produced nothing.
  const finalErrorCode    = !cascadeAllowed && suppressedErrorCode    ? suppressedErrorCode    : 'DATA_DEGRADED';
  const finalErrorMessage = !cascadeAllowed && suppressedErrorMessage
    ? suppressedErrorMessage
    : 'Kite failed and no fallback returned data';
  const r = emptyResult({
    provider: 'none', status: 'failed',
    errorCode: finalErrorCode,
    errorMessage: finalErrorMessage,
    symbolsAsked: symbols, startedAt, startTs,
    fallbackUsed: cascadeAllowed,
  });
  logResolverOutcome(symbols.length, r, primaryFailureReason);
  return r;
}

export async function resolveSingle(
  symbol: string,
  opts: ResolveOpts = {},
): Promise<ResolverResult & { snapshot: MarketSnapshot | null }> {
  const signal = opts.signal;
  const sym = String(symbol ?? '').trim().toUpperCase();
  const startedAt = nowIso();
  const startTs   = Date.now();

  if (!sym) {
    const r = emptyResult({
      provider: 'none', status: 'failed',
      errorCode: 'EMPTY_REQUEST', errorMessage: 'symbol required',
      symbolsAsked: [], startedAt, startTs,
    });
    return { ...r, snapshot: null };
  }

  // Spec NIFTY500_LOCK_ENABLED — refuse to fetch outside the locked
  // universe. Symmetric with resolveBatch's pre-gate filter so a
  // bypassed code path can't sneak a non-member symbol through.
  if (process.env.NIFTY500_LOCK !== '0' && !isInNifty500(sym)) {
    log.warn('resolveSingle rejected symbol outside NIFTY 500', { symbol: sym });
    const r = emptyResult({
      provider: 'none', status: 'failed',
      errorCode: 'NIFTY500_LOCK_REJECTED',
      errorMessage: `symbol ${sym} is outside the NIFTY 500 universe`,
      symbolsAsked: [sym], startedAt, startTs,
    });
    return { ...r, snapshot: null };
  }

  // IndianAPI mode: no request-path upstream — resolveBatch serves
  // the cache-only chain and returns a loud degraded result on miss.
  if (getMarketDataProvider() === 'indianapi') {
    const batch = await resolveBatch([sym], { signal });
    return { ...batch, snapshot: batch.snapshots.get(sym) ?? null };
  }

  // Always try Kite getQuote first (Phase 1 — no vendor stock-details path).
  logProviderEvent('attempt', {
    provider: 'kite',
    method: 'getQuote',
    symbol: sym,
  });
  try {
    const snap = await Kite.getQuote(sym);
    if (snap && Number.isFinite(snap.price) && snap.price > 0) {
      await writeCacheBatch([snap]);
      notePrimaryOutcome(true);
      logProviderEvent('success', {
        provider: 'kite',
        selected: getMarketDataProvider(),
        fallback: 'none',
        symbol: sym,
      });
      const result: ResolverResult = {
        provider: 'kite',
        status: 'success',
        dataQuality: 'HIGH',
        requestStartedAt: startedAt,
        responseReceivedAt: nowIso(),
        latencyMs: Date.now() - startTs,
        symbolsRequested: 1,
        symbolsReturned: 1,
        coveragePercent: 100,
        staleSymbols: [],
        failedSymbols: [],
        errorCode: null,
        errorMessage: null,
        fallbackUsed: false,
        snapshots: snapshotsToMap([snap]),
        data: snapshotsToDataRecord([snap], 'kite'),
      };
      return { ...result, snapshot: snap };
    }
  } catch (err) {
    notePrimaryOutcome(false);
    logProviderEvent('fallback', {
      from: 'kite',
      to: 'resolveBatch',
      symbol: sym,
      reason: err instanceof Error ? err.name : 'error',
      recoverable: isRecoverableKiteError(err),
    });
    // Fall through to resolveBatch cascade (cache → NSE → Yahoo).
  }

  const batch = await resolveBatch([sym], { signal });
  return { ...batch, snapshot: batch.snapshots.get(sym) ?? null };
}

// ════════════════════════════════════════════════════════════════
//  Backwards-compat shim — the legacy `resolvePrice` / `resolvePrices`
//  / `summarizeQuality` names are kept so the existing rescore +
//  lifecycle workers keep compiling. Step 9 migrates them to the
//  new envelope; until then they get a byte-equivalent shape.
// ════════════════════════════════════════════════════════════════

export type Source  = 'kite' | 'yahoo' | 'nse' | 'cache' | 'none' | null; // @deprecated marker
export type Quality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ResolvedPrice {
  symbol:  string;
  price:   number | null;
  source:  Source;
  fresh:   boolean;
  ts:      number | null;
  pChange: number | null;
  quality: Quality;
}

function toResolvedPrice(
  symbol: string,
  snap: MarketSnapshot | null,
  provider: ResolverProvider,
  quality: ResolverQuality,
): ResolvedPrice {
  if (!snap || !Number.isFinite(snap.price) || snap.price <= 0) {
    return {
      symbol, price: null, source: null, fresh: false, ts: null,
      pChange: null, quality: 'LOW',
    };
  }
  const source: Source =
    provider === 'kite'      ? 'kite' :
    provider === 'cache'     ? 'cache' :
    provider === 'snapshot'  ? 'cache' :
    provider === 'yahoo_emergency' ? 'yahoo' : // @deprecated marker
    provider === 'nse_direct' ? 'nse' :
    'none';
  return {
    symbol,
    price: snap.price,
    source,
    fresh: quality === 'HIGH',
    ts: snap.timestamp || Date.now(),
    pChange: snap.changePercent ?? null,
    quality,
  };
}

export async function resolve(
  symbol: string,
  opts: ResolveOpts = {},
): Promise<ResolverResult> {
  return resolveBatch([symbol], opts);
}

export async function resolvePrice(symbol: string): Promise<ResolvedPrice> {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) {
    return { symbol: '', price: null, source: null, fresh: false, ts: null, pChange: null, quality: 'LOW' };
  }
  const r = await resolveSingle(sym);
  return toResolvedPrice(sym, r.snapshot, r.provider, r.dataQuality);
}

export async function resolvePrices(
  symbols: string[],
  _opts: { concurrency?: number } = {},
): Promise<ResolvedPrice[]> {
  const clean = [...new Set(symbols.map(s => String(s ?? '').trim().toUpperCase()).filter(Boolean))];
  const r = await resolveBatch(clean);
  return clean.map((sym) => toResolvedPrice(
    sym, r.snapshots.get(sym) ?? null, r.provider, r.dataQuality,
  ));
}

export function summarizeQuality(resolved: ResolvedPrice[]): {
  high: number; medium: number; low: number; kiteRatio: number; // @deprecated marker
} {
  let high = 0, medium = 0, low = 0;
  for (const r of resolved) {
    if (r.quality === 'HIGH') high++;
    else if (r.quality === 'MEDIUM') medium++;
    else low++;
  }
  const total = resolved.length;
  const kiteRatio = total > 0 ? Math.round((high / total) * 100) : 0; // @deprecated marker
  return { high, medium, low, kiteRatio }; // @deprecated marker
}

// ── Spec SMART_FALLBACK §6 envelope helper ────────────────────────
//
// Compact `{ provider_used, fallback_used, market_state, symbols_processed }`
// shape that callers (route handlers) attach to their JSON responses.
// Built from a `ResolverResult` so the upstream call site doesn't have
// to reach for `getMarketStatus()` separately.

export type SmartFallbackProvider =
  | 'kite'
  | 'nse'
  | 'yahoo'
  | 'snapshot'
  | 'cache'
  | 'none';

export interface SmartFallbackEnvelope {
  provider_used:     SmartFallbackProvider;
  fallback_used:     boolean;
  market_state:      'open' | 'closed';
  symbols_processed: number;
}

/** Map the resolver's internal `ResolverProvider` to the spec's
 *  shorter alias set. `nse_direct` collapses to `nse`,
 *  `yahoo_emergency` to `yahoo`, everything else stays as-is. */
function mapProviderForEnvelope(p: ResolverProvider): SmartFallbackProvider {
  if (p === 'nse_direct')      return 'nse';
  if (p === 'yahoo_emergency') return 'yahoo';
  return p;
}

/**
 * Build the §6-spec envelope from a resolver result. `market_state`
 * is read live (not from the result) because a single resolve can
 * straddle the open/close boundary at 15:30 IST, and the human-facing
 * envelope should reflect the current wall clock.
 */
export function buildSmartFallbackEnvelope(r: ResolverResult): SmartFallbackEnvelope {
  return {
    provider_used:     mapProviderForEnvelope(r.provider),
    fallback_used:     r.fallbackUsed,
    market_state:      isMarketOpen() ? 'open' : 'closed',
    symbols_processed: r.symbolsReturned,
  };
}
