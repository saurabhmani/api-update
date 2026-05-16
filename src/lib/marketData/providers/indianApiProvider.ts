// ════════════════════════════════════════════════════════════════
//  IndianAPI Provider — Step 3 of the IndianAPI cutover.
//
//  This module is the high-level provider that the rest of the app
//  talks to. It wraps the low-level HTTP adapter
//  (src/providers/adapters/IndianAPIAdapter.ts) and adds the
//  observability + accounting envelope every call site needs:
//
//    • request timestamp + response timestamp + latencyMs
//    • per-request usage counting (apiBudgetGuard)
//    • symbol-coverage percentage on batch requests
//    • per-row freshness score
//    • normalized error envelope (never throws to the caller)
//    • cache pass-through where it's correct to cache
//
//  Every method returns a `ProviderInvocation<T>` envelope, never
//  throws. Callers branch on `status` and `dataQuality` rather than
//  try/catch.
//
//  This file is the ONLY allowed importer of @/providers/adapters/
//  outside the providers/ tree itself, plus the resolver. New code
//  must not call IndianAPIAdapter directly — go through this wrapper
//  so envelopes, accounting, and the feed-health log stay consistent.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import * as IndianAPI from '@/providers/adapters/IndianAPIAdapter';
import type {
  CorporateIntel,
  Fundamentals,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversBucket,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';
import type { NewsItem, BatchQuoteResult } from '@/providers/adapters/IndianAPIAdapter';
import { canSpend, spend, type RequestType } from '@/lib/marketData/apiBudgetGuard';
import { logFeedHealth } from '@/lib/marketData/feedHealthLog';
import { mapToIndianApiSymbol, mapManyToIndianApiSymbol } from '@/lib/marketData/symbolMapper';

const log = logger.child({ component: 'indianApiProvider' });

// ── Public envelope ────────────────────────────────────────────────

export type InvocationStatus = 'success' | 'partial' | 'failed' | 'degraded';
export type InvocationQuality = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Envelope returned by every method on this provider. Even on
 * failure the envelope is well-formed; `data` is null and
 * `errorCode` / `errorMessage` describe the failure.
 */
export interface ProviderInvocation<T> {
  /** Vendor identifier — always 'indianapi' here. */
  provider: 'indianapi';

  /** Operation name (e.g. 'batchQuote', 'historical', 'marketNews'). */
  endpoint: string;

  /** ISO timestamps capture exact request boundary. */
  requestStartedAt:   string;
  responseReceivedAt: string;
  latencyMs:          number;

  /** Outcome rollup. */
  status:      InvocationStatus;
  dataQuality: InvocationQuality;

  /** Batch operations only — symbol coverage. */
  symbolsRequested: number;
  symbolsReturned:  number;
  coveragePercent:  number;

  /** When applicable — symbols that came back with stale or no data. */
  staleSymbols:  string[];
  failedSymbols: string[];

  /** Freshness score 0–100. 100 = vendor stamped 'now'. 0 = unknown / very old. */
  freshnessScore: number;

  /** Normalized error description. null on success. */
  errorCode:    string | null;
  errorMessage: string | null;

  /** The actual payload. null on hard failure. */
  data: T | null;
}

// ── Helpers ────────────────────────────────────────────────────────

const FRESHNESS_HALF_LIFE_MIN = 15; // 15-min upstream cadence; >30 min => below 50

function freshnessFromTimestamp(tsMs: number | null | undefined): number {
  if (!tsMs || !Number.isFinite(tsMs)) return 0;
  const ageMin = Math.max(0, (Date.now() - tsMs) / 60_000);
  // exponential decay; halves every FRESHNESS_HALF_LIFE_MIN minutes.
  const score = Math.round(100 * Math.pow(0.5, ageMin / FRESHNESS_HALF_LIFE_MIN));
  return Math.max(0, Math.min(100, score));
}

function classifyQuality(coverage: number, freshness: number): InvocationQuality {
  if (coverage <= 0 && freshness <= 0) return 'LOW';
  if (coverage >= 95 && freshness >= 70) return 'HIGH';
  if (coverage >= 60 && freshness >= 40) return 'MEDIUM';
  return 'LOW';
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RunOpts<T> {
  endpoint:     string;
  requestType:  RequestType;
  cost:         number;
  /** When provided, used to compute coverage / per-row freshness. */
  symbolsAsked?: string[];
  /** Inspect a successful payload to derive symbolsReturned / freshness / etc. */
  meta?: (data: T) => {
    symbolsReturned?: number;
    failedSymbols?:   string[];
    staleSymbols?:    string[];
    freshness?:       number;
    timestamp?:       number;
  };
}

/**
 * Wrap an adapter call. Handles timing, budget accounting, error
 * normalization, the feed-health log row, and the envelope shape.
 *
 * On budget denial → status='degraded', data=null, errorCode='BUDGET_*'.
 * On adapter throw → status='failed',   data=null, errorCode='UPSTREAM_ERROR'.
 * On success       → status='success' | 'partial', data populated.
 */
/** Live-price request types — refused by the market-closed defensive
 *  guard below. News / hist / corp / search are NOT time-sensitive and
 *  remain allowed off-hours so news ingestion + on-demand corp/intel
 *  routes keep working. The resolver also has its own gate before this
 *  one; this is a belt-and-braces second line of defence so any future
 *  caller that bypasses the resolver still cannot leak quota off-hours. */
const LIVE_PRICE_REQUEST_TYPES: ReadonlyArray<RequestType> = ['batch', 'adhoc', 'movers'];
// Production spec: "IF market CLOSED: BLOCK ALL external API calls".
// When INDIANAPI_BLOCK_ALL_OFF_HOURS=1 (default per spec) we extend
// the gate to cover hist / news / corp / search / deep too, since
// they all spend the same monthly budget. Operators who legitimately
// need off-hours news/corp ingestion can flip this to 0 and rely on
// the narrower LIVE_PRICE_REQUEST_TYPES allowlist instead.
function isStrictOffHoursBlock(): boolean {
  return process.env.INDIANAPI_BLOCK_ALL_OFF_HOURS !== '0';
}

async function runIndianApi<T>(
  fn:   (signal?: AbortSignal) => Promise<T>,
  opts: RunOpts<T>,
  signal?: AbortSignal,
): Promise<ProviderInvocation<T>> {
  const requestStartedAt = nowIso();
  const t0 = Date.now();
  const symbolsAsked = opts.symbolsAsked ?? [];
  const symbolsRequested = symbolsAsked.length;

  // ── Market-closed defensive guard ─────────────────────────────
  // Default ON (env INDIANAPI_BLOCK_OUTSIDE_MARKET=0 to disable). When
  // the NSE cash session is closed, refuse every live-price-flavoured
  // request without spending budget. Returns the same `degraded`
  // envelope shape the budget guard uses so existing fallback chains
  // (resolver → cache → market_close_snapshot) absorb it identically.
  //
  // Spec "REMOVE IndianAPI market-closed blocking" / "ALLOW EOD DATA
  // FOR SIGNALS" — `hist` (historical_data) is exempt from the
  // off-hours gate. Daily OHLCV doesn't change once a bar closes, so
  // blocking it after 15:30 IST just kills overnight signal
  // generation against EOD data. Live-price types ('batch', 'adhoc',
  // 'movers') still get blocked off-hours since they spend budget on
  // a value that can't change while the session is closed.
  const blockGateActive = process.env.INDIANAPI_BLOCK_OUTSIDE_MARKET !== '0';
  const strictBlockAll  = isStrictOffHoursBlock();
  const histExempt      = opts.requestType === 'hist';
  const blockedByType   = !histExempt && (
    strictBlockAll || LIVE_PRICE_REQUEST_TYPES.includes(opts.requestType)
  );
  if (blockGateActive && blockedByType) {
    const { isMarketOpen } = await import('../marketHours');
    if (!isMarketOpen()) {
      const responseReceivedAt = nowIso();
      const latencyMs = Date.now() - t0;
      // Spec-required log line — grep on `API BLOCKED — MARKET CLOSED`.
      log.warn('API BLOCKED — MARKET CLOSED', {
        endpoint: opts.endpoint, requestType: opts.requestType,
        symbolsRequested, strict: strictBlockAll,
      });
      const env: ProviderInvocation<T> = {
        provider: 'indianapi',
        endpoint: opts.endpoint,
        requestStartedAt,
        responseReceivedAt,
        latencyMs,
        status: 'degraded',
        dataQuality: 'LOW',
        symbolsRequested,
        symbolsReturned: 0,
        coveragePercent: 0,
        staleSymbols: [],
        failedSymbols: [...symbolsAsked],
        freshnessScore: 0,
        errorCode: 'MARKET_CLOSED',
        errorMessage: 'NSE cash session closed — IndianAPI live-price call suppressed (INDIANAPI_BLOCK_OUTSIDE_MARKET)',
        data: null,
      };
      void logFeedHealth({
        provider: 'indianapi',
        endpoint: opts.endpoint,
        request_started_at: requestStartedAt,
        response_received_at: responseReceivedAt,
        status: 'degraded',
        latency_ms: latencyMs,
        symbols_requested: symbolsRequested,
        symbols_returned: 0,
        coverage_percent: 0,
        data_quality: 'LOW',
        error_code: 'MARKET_CLOSED',
        error_message: env.errorMessage,
      });
      return env;
    }
  }

  // Budget gate — refuse the call rather than spend on a deny.
  const gate = await canSpend(opts.requestType, opts.cost);
  if (!gate.allowed) {
    // Spec-required log line — grep on `API BLOCKED — BUDGET LIMIT`.
    log.warn('API BLOCKED — BUDGET LIMIT', {
      endpoint: opts.endpoint, requestType: opts.requestType,
      cost: opts.cost, level: gate.level, reason: gate.reason,
    });
    const responseReceivedAt = nowIso();
    const latencyMs = Date.now() - t0;
    const code = gate.reason?.includes('freeze') ? 'BUDGET_EXHAUSTED' : 'BUDGET_THROTTLED';
    const env: ProviderInvocation<T> = {
      provider: 'indianapi',
      endpoint: opts.endpoint,
      requestStartedAt,
      responseReceivedAt,
      latencyMs,
      status: code === 'BUDGET_EXHAUSTED' ? 'failed' : 'degraded',
      dataQuality: 'LOW',
      symbolsRequested,
      symbolsReturned: 0,
      coveragePercent: 0,
      staleSymbols: [],
      failedSymbols: [...symbolsAsked],
      freshnessScore: 0,
      errorCode: code,
      errorMessage: gate.reason ?? 'budget guard refused the request',
      data: null,
    };
    void logFeedHealth({
      provider: 'indianapi',
      endpoint: opts.endpoint,
      request_started_at: requestStartedAt,
      response_received_at: responseReceivedAt,
      status: env.status,
      latency_ms: latencyMs,
      symbols_requested: symbolsRequested,
      symbols_returned: 0,
      coverage_percent: 0,
      data_quality: 'LOW',
      error_code: code,
      error_message: env.errorMessage,
    });
    return env;
  }

  // Spend BEFORE the call — a failed call still costs us quota in
  // most metering schemes; matches the existing apiBudgetGuard semantics.
  await spend(opts.requestType, opts.cost);
  // Spec-required log line — grep on `API CALL EXECUTED`. Emitted
  // exactly once per upstream call, after budget+market gates have
  // cleared and before the network roundtrip starts.
  log.info('API CALL EXECUTED', {
    endpoint: opts.endpoint, requestType: opts.requestType,
    cost: opts.cost, symbolsRequested,
  });

  let data: T | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    data = await fn(signal);
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number };
    errorCode = (e?.status ? `HTTP_${e.status}` : (e?.name ?? 'UPSTREAM_ERROR'));
    errorMessage = e?.message ?? String(err);
    log.warn('IndianAPI call failed', {
      endpoint: opts.endpoint, errorCode, errorMessage,
    });
  }

  const responseReceivedAt = nowIso();
  const latencyMs = Date.now() - t0;

  if (data == null) {
    const env: ProviderInvocation<T> = {
      provider: 'indianapi',
      endpoint: opts.endpoint,
      requestStartedAt,
      responseReceivedAt,
      latencyMs,
      status: 'failed',
      dataQuality: 'LOW',
      symbolsRequested,
      symbolsReturned: 0,
      coveragePercent: 0,
      staleSymbols: [],
      failedSymbols: [...symbolsAsked],
      freshnessScore: 0,
      errorCode: errorCode ?? 'UPSTREAM_NULL',
      errorMessage: errorMessage ?? 'upstream returned no data',
      data: null,
    };
    void logFeedHealth({
      provider: 'indianapi',
      endpoint: opts.endpoint,
      request_started_at: requestStartedAt,
      response_received_at: responseReceivedAt,
      status: 'failed',
      latency_ms: latencyMs,
      symbols_requested: symbolsRequested,
      symbols_returned: 0,
      coverage_percent: 0,
      data_quality: 'LOW',
      error_code: env.errorCode,
      error_message: env.errorMessage,
    });
    return env;
  }

  const inspected = opts.meta ? opts.meta(data) : {};
  const symbolsReturned = inspected.symbolsReturned ?? (symbolsRequested ? symbolsRequested : 1);
  const failedSymbols = inspected.failedSymbols ?? [];
  const staleSymbols  = inspected.staleSymbols  ?? [];
  const coveragePercent = symbolsRequested > 0
    ? Math.round((symbolsReturned / symbolsRequested) * 100)
    : (symbolsReturned > 0 ? 100 : 0);
  const freshnessScore = inspected.freshness ?? freshnessFromTimestamp(inspected.timestamp);
  const status: InvocationStatus =
    failedSymbols.length === 0 && coveragePercent >= 99
      ? 'success'
      : (coveragePercent > 0 ? 'partial' : 'failed');
  const dataQuality = classifyQuality(coveragePercent, freshnessScore);

  void logFeedHealth({
    provider: 'indianapi',
    endpoint: opts.endpoint,
    request_started_at: requestStartedAt,
    response_received_at: responseReceivedAt,
    status,
    latency_ms: latencyMs,
    symbols_requested: symbolsRequested,
    symbols_returned: symbolsReturned,
    coverage_percent: coveragePercent,
    data_quality: dataQuality,
    error_code: null,
    error_message: null,
  });

  return {
    provider: 'indianapi',
    endpoint: opts.endpoint,
    requestStartedAt,
    responseReceivedAt,
    latencyMs,
    status,
    dataQuality,
    symbolsRequested,
    symbolsReturned,
    coveragePercent,
    staleSymbols,
    failedSymbols,
    freshnessScore,
    errorCode: null,
    errorMessage: null,
    data,
  };
}

// ════════════════════════════════════════════════════════════════
//  Public surface
// ════════════════════════════════════════════════════════════════

// ── Single-symbol live snapshot ────────────────────────────────────

export async function getStockDetails(
  symbol: string,
  signal?: AbortSignal,
): Promise<ProviderInvocation<MarketSnapshot>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi((sig) => IndianAPI.getQuote(sym, sig), { // @deprecated marker
    endpoint: 'stock',
    requestType: 'adhoc',
    cost: 1,
    symbolsAsked: [sym],
    meta: (snap) => ({
      symbolsReturned: snap?.price ? 1 : 0,
      timestamp: snap?.timestamp,
    }),
  }, signal);
}

// ── Batch live snapshot (NSE / BSE) ────────────────────────────────

/**
 * Build a synthetic "route removed" invocation envelope for endpoints
 * whose IndianAPI route was deleted from the catalog on 2026-05-01
 * (no working upstream path on this plan). Returns the same envelope
 * shape `runIndianApi` would emit for a failure, but skips the
 * budget-guard `spend()` call so dead routes do not eat into the
 * batch / hist / corp quotas. Resolver / scheduler call sites already
 * treat `status: 'failed'` as "fall through to cache".
 */
function deadRouteInvocation<T>(
  endpoint: string,
  symbolsAsked: string[],
): ProviderInvocation<T> {
  const ts = nowIso();
  return {
    provider: 'indianapi',
    endpoint,
    requestStartedAt: ts,
    responseReceivedAt: ts,
    latencyMs: 0,
    status: 'failed',
    dataQuality: 'LOW',
    symbolsRequested: symbolsAsked.length,
    symbolsReturned: 0,
    coveragePercent: 0,
    staleSymbols: [],
    failedSymbols: [...symbolsAsked],
    freshnessScore: 0,
    errorCode: 'ROUTE_REMOVED',
    errorMessage: `${endpoint} removed from catalog 2026-05-01 — no working IndianAPI path on this plan`,
    data: null,
  };
}

/**
 * Batch live snapshot — emulated via concurrent /stock fan-out in the
 * adapter (since IndianAPI's native /nse/batch_quote 404s on this plan).
 * Cost is metered as 1 unit per symbol because that's the actual
 * upstream call count, NOT 1 unit per batch as the original
 * /nse/batch_quote would have been. The adapter caps per-call symbol
 * count at INDIANAPI_EMULATED_BATCH_MAX (default 50) to keep monthly
 * burn under the 70k ceiling — symbols beyond the cap come back in
 * `missing[]` and the resolver falls them through to cache.
 */
export async function getNseBatchLivePrice(
  symbols: string[],
  signal?: AbortSignal,
): Promise<ProviderInvocation<BatchQuoteResult>> {
  const mapped = await mapManyToIndianApiSymbol(symbols);
  const clean = [...new Set(mapped.filter(Boolean))];
  if (clean.length === 0) {
    return deadRouteInvocation<BatchQuoteResult>('nse/batch_quote(emulated)', clean);
  }
  // Emulation cost = 1 /stock call per symbol fetched. Cap matches
  // the adapter's MAX_EMULATED_BATCH_SYMBOLS so the budget guard sees
  // the same number the adapter will actually issue.
  const adapterCap = Math.max(1, Number(process.env.INDIANAPI_EMULATED_BATCH_MAX) || 50);
  const cost = Math.min(clean.length, adapterCap);
  return runIndianApi((sig) => IndianAPI.getBatchQuotes(clean, 'NSE', sig), {
    endpoint: 'stock(emulated_batch)',
    requestType: 'batch',
    cost,
    symbolsAsked: clean,
    meta: (res) => ({
      symbolsReturned: res.snapshots.length,
      failedSymbols: res.missing,
      timestamp: res.snapshots[0]?.timestamp,
    }),
  }, signal);
}

export const getBseBatchLivePrice = getNseBatchLivePrice;

// ── Intraday (1-day) ───────────────────────────────────────────────

/** REMOVED route — `/intraday` 404s on this plan. Returns a synthetic
 *  failed invocation without burning budget. Candle scheduler already
 *  falls back to /historical_data on intraday miss. */
export async function getIntradayCandles(
  symbol: string,
): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return deadRouteInvocation<unknown>('intraday', [sym]);
}

// ── Historical (daily) ─────────────────────────────────────────────

export async function getHistorical(
  symbol: string,
  range: HistoricalRange = '1y',
  signal?: AbortSignal,
): Promise<ProviderInvocation<HistoricalSeries>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi((sig) => IndianAPI.getHistorical(sym, range, sig), {
    endpoint: `historical_data:${range}`,
    requestType: 'hist',
    cost: 1,
    symbolsAsked: [sym],
    meta: (s) => ({
      symbolsReturned: s.candles.length > 0 ? 1 : 0,
      timestamp: s.candles[s.candles.length - 1]?.t,
    }),
  }, signal);
}

// ── Market overview ────────────────────────────────────────────────

export function getTrendingSymbols(signal?: AbortSignal): Promise<ProviderInvocation<string[]>> {
  return runIndianApi((sig) => IndianAPI.getTrendingSymbols(sig), {
    endpoint: 'trending',
    requestType: 'movers',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length }),
  }, signal);
}

export function getMovers(signal?: AbortSignal): Promise<ProviderInvocation<MoversResult>> {
  return runIndianApi((sig) => IndianAPI.getMovers(sig), {
    endpoint: 'trending:movers',
    requestType: 'movers',
    cost: 1,
    meta: (r) => ({ symbolsReturned: r.gainers.length + r.losers.length }),
  }, signal);
}

export function getNseMostActive(): Promise<ProviderInvocation<MoversBucket[]>> {
  return runIndianApi(() => IndianAPI.getNseMostActive(), {
    endpoint: 'NSE_most_active',
    requestType: 'movers',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length }),
  });
}

export function getBseMostActive(): Promise<ProviderInvocation<MoversBucket[]>> {
  return runIndianApi(() => IndianAPI.getBseMostActive(), {
    endpoint: 'BSE_most_active',
    requestType: 'movers',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length }),
  });
}

export function getPriceShockers(): Promise<ProviderInvocation<string[]>> {
  return runIndianApi(() => IndianAPI.getPriceShockers(), {
    endpoint: 'price_shockers',
    requestType: 'movers',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length }),
  });
}

/** Market indices snapshot (broad indices like NIFTY/SENSEX). */
export function get52WeekHighLow(): Promise<ProviderInvocation<unknown>> {
  return runIndianApi(() => IndianAPI.get52WeekHighLow(), {
    endpoint: 'fetch_52_week_high_low_data',
    requestType: 'movers',
    cost: 1,
  });
}

// ── Corporate / event intelligence ─────────────────────────────────

export async function getCorporateIntel(symbol: string): Promise<ProviderInvocation<CorporateIntel>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(() => IndianAPI.getCorporateIntel(sym), {
    endpoint: 'stock:corp',
    requestType: 'corp',
    cost: 1,
    symbolsAsked: [sym],
    meta: (r) => ({ symbolsReturned: r ? 1 : 0 }),
  });
}

export async function getFundamentals(symbol: string): Promise<ProviderInvocation<Fundamentals>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(() => IndianAPI.getFundamentals(sym), {
    endpoint: 'fundamentals',
    requestType: 'corp',
    // Adapter no longer fans out — /stock_forecasts + /stock_target_price
    // were 422'ing on the wrong-param shape and their response bodies
    // never matched the mapper anyway. One /stock call until a proper
    // mapping for the real forecast / target_price shapes lands.
    cost: 1,
    symbolsAsked: [sym],
    meta: (r) => ({ symbolsReturned: r ? 1 : 0, timestamp: r?.asOf }),
  });
}

/** REMOVED route — `/industry_peers` 404s on this plan. Returns a
 *  synthetic failed invocation without burning budget. */
export async function getIndustryPeers(symbol: string): Promise<ProviderInvocation<IndustryPeer[]>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return deadRouteInvocation<IndustryPeer[]>('industry_peers', [sym]);
}

/**
 * Corporate actions, announcements, conference calls, annual reports,
 * and company documents share a single underlying detail endpoint
 * on most IndianAPI plans (`/stock_target_price` + `/historical_stats`).
 * We expose them as discrete methods so callers stay aligned with the
 * spec; under the hood they all hit the adapter's documented surfaces.
 *
 * If your plan exposes dedicated paths, swap the adapter call here
 * — every consumer keeps working unchanged.
 */
export async function getCorporateActions(symbol: string): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(
    () => IndianAPI.getHistoricalStats(sym, 'corporate_actions'),
    { endpoint: 'historical_stats:corporate_actions', requestType: 'corp', cost: 1, symbolsAsked: [sym] },
  );
}

export async function getRecentAnnouncements(symbol: string): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(
    () => IndianAPI.getHistoricalStats(sym, 'announcements'),
    { endpoint: 'historical_stats:announcements', requestType: 'corp', cost: 1, symbolsAsked: [sym] },
  );
}

export async function getConferenceCalls(symbol: string): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(
    () => IndianAPI.getHistoricalStats(sym, 'conference_calls'),
    { endpoint: 'historical_stats:conference_calls', requestType: 'corp', cost: 1, symbolsAsked: [sym] },
  );
}

export async function getAnnualReports(symbol: string): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(
    () => IndianAPI.getHistoricalStats(sym, 'annual_reports'),
    { endpoint: 'historical_stats:annual_reports', requestType: 'corp', cost: 1, symbolsAsked: [sym] },
  );
}

export async function getCompanyDocuments(symbol: string): Promise<ProviderInvocation<unknown>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi(
    () => IndianAPI.getHistoricalStats(sym, 'documents'),
    { endpoint: 'historical_stats:documents', requestType: 'corp', cost: 1, symbolsAsked: [sym] },
  );
}

// ── News ───────────────────────────────────────────────────────────

export function getMarketNews(signal?: AbortSignal): Promise<ProviderInvocation<NewsItem[]>> {
  return runIndianApi((sig) => IndianAPI.getMarketNews(sig), {
    endpoint: 'market_news',
    requestType: 'news',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length, timestamp: arr[0]?.publishedAt }),
  }, signal);
}

export async function getCompanyNews(symbol: string, signal?: AbortSignal): Promise<ProviderInvocation<NewsItem[]>> {
  const sym = await mapToIndianApiSymbol(symbol);
  return runIndianApi((sig) => IndianAPI.getCompanyNews(sym, sig), {
    endpoint: 'stock_news',
    requestType: 'news',
    cost: 1,
    symbolsAsked: [sym],
    meta: (arr) => ({ symbolsReturned: arr.length, timestamp: arr[0]?.publishedAt }),
  }, signal);
}

/** AI-curated news. Routes through the adapter's dedicated endpoint
 *  (path marked VERIFY in `indianApiEndpoints.ts`). */
export function getAiCuratedNews(signal?: AbortSignal): Promise<ProviderInvocation<NewsItem[]>> {
  return runIndianApi((sig) => IndianAPI.getAiCuratedNews('economy', sig), {
    endpoint: 'ai_curated_news',
    requestType: 'news',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length, timestamp: arr[0]?.publishedAt }),
  }, signal);
}

/** GET /usage — current account usage as reported by IndianAPI itself.
 *  Used by the budget guard for an authoritative cross-check against
 *  the locally-counted spend. Cheap, infrequent. */
export function getUsage(signal?: AbortSignal): Promise<ProviderInvocation<unknown>> {
  return runIndianApi((sig) => IndianAPI.getUsage(sig), {
    endpoint: 'usage',
    requestType: 'adhoc',
    cost: 1,
  }, signal);
}

// ── Symbol search ──────────────────────────────────────────────────

export function searchSymbols(query: string, signal?: AbortSignal): Promise<ProviderInvocation<SymbolSearchHit[]>> {
  return runIndianApi((sig) => IndianAPI.searchSymbol(query, sig), {
    endpoint: 'industry_search',
    requestType: 'search',
    cost: 1,
    meta: (arr) => ({ symbolsReturned: arr.length }),
  }, signal);
}

// ── Default export for ergonomic single-import ────────────────────

export const indianApiProvider = {
  getStockDetails,
  getNseBatchLivePrice,
  getBseBatchLivePrice,
  getIntradayCandles,
  getHistorical,
  getTrendingSymbols,
  getMovers,
  getNseMostActive,
  getBseMostActive,
  getPriceShockers,
  get52WeekHighLow,
  getCorporateIntel,
  getFundamentals,
  getIndustryPeers,
  getCorporateActions,
  getRecentAnnouncements,
  getConferenceCalls,
  getAnnualReports,
  getCompanyDocuments,
  getMarketNews,
  getCompanyNews,
  getAiCuratedNews,
  searchSymbols,
  getUsage,
};

export default indianApiProvider;
