// ════════════════════════════════════════════════════════════════
//  IndianAPIAdapter — HTTP client for indianapi.in (INGESTION-ONLY).
//
//  Responsibilities:
//    • Single-purpose: HTTP to indianapi.in and nothing else.
//    • Normalizes every payload into the canonical types from
//      /src/types/market.ts via indianApiMappers before returning.
//    • Detects 429s, honors Retry-After by pausing the shared rate
//      limiter, and throws IndianApiRateLimitError — it NEVER retries
//      itself. Retry/backoff policy belongs to the ingestion
//      orchestrator; retries are not a rate-limiting solution.
//    • Never decides fallback policy — MarketDataProvider serves
//      clients from cache/DB; this adapter is only invoked by
//      ingestion jobs.
//
//  Architecture freeze: importable ONLY from src/providers/**,
//  src/lib/marketData/providers/**, src/lib/marketData/ingestion/**
//  and tests. Request-path imports fail architectureFreeze.vitest.ts.
// ════════════════════════════════════════════════════════════════

import axios, { AxiosError, AxiosInstance } from 'axios';
import { Agent as HttpsAgent } from 'https';
import { Agent as HttpAgent } from 'http';
import { logger } from '@/lib/logger';
import type {
  CorporateIntel,
  HistoricalRange,
  HistoricalSeries,
  MarketSnapshot,
  MoversResult,
} from '@/types/market';
import {
  getIndianApiConfig,
  INDIANAPI_AUTH_HEADER,
  INDIANAPI_BATCH_BODY_KEY,
  INDIANAPI_ENDPOINTS,
  isEndpointAvailable,
  markEndpointUnavailable,
  noteEndpointSuccess,
  getEndpointUnavailableReason,
  type EndpointName,
} from '@/lib/marketData/providers/indianApiEndpoints';
import {
  mapBatchItemToSnapshot,
  mapHistorical,
  mapStockToCorporateIntel,
  mapStockToSnapshot,
  mapTrendingToMovers,
  rangeToPeriod,
} from '@/lib/marketData/providers/indianApiMappers';
import type {
  RawIndianApiBatchQuoteItem,
  RawIndianApiHistorical,
  RawIndianApiMostActive,
  RawIndianApiStock,
  RawIndianApiTrending,
  RawIndianApiUsage,
} from '@/lib/marketData/providers/indianApiTypes';
import {
  getIndianApiRateLimiter,
  type IndianApiEndpointGroup,
} from '@/lib/marketData/providers/indianApiRateLimiter';
import { checkApiBudget, incrementApiUsage } from './indianApiUsageTracker';
import { logProviderRequest } from '@/lib/marketData/providerRequestLog';
import { recordIndianApiRequest } from '@/lib/monitor/institutionalHealth';

export {
  ApiBudgetExceededError,
  getApiUsage,
  beginPerRunBudget,
  endPerRunBudget,
  type ApiUsageSnapshot,
  type ApiBudgetBucket,
} from './indianApiUsageTracker';

const log = logger.child({ adapter: 'IndianAPI' });

export const INDIANAPI_PROVIDER_NAME = 'indianapi';

// ── Error taxonomy ─────────────────────────────────────────────────

/** Missing credentials — a configuration error, never silently absorbed. */
export class IndianApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndianApiConfigError';
  }
}

/** Upstream 429. Carries the Retry-After the orchestrator must honor. */
export class IndianApiRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number, endpoint: string) {
    super(`IndianAPI 429 rate-limited on ${endpoint} (retry after ${retryAfterMs}ms)`);
    this.name = 'IndianApiRateLimitError';
  }
}

/** Non-429 HTTP failure. `transient` guides orchestrator retry policy. */
export class IndianApiHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = 'IndianApiHttpError';
  }
}

// ── Shared axios client with keep-alive ────────────────────────────
//
// One cached instance + keep-alive agents so the TLS handshake is
// reused across the ingestion fan-out. Rebuilt only when a
// config-bearing dimension changes (key rotation, base URL flip).

let _httpClient: AxiosInstance | null = null;
let _httpClientForKey: string | null = null;

const HTTP_AGENT_MAX_SOCKETS = 25;

function http(): AxiosInstance {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) {
    throw new IndianApiConfigError(
      'INDIANAPI_API_KEY (or INDIANAPI_KEY / INDIAN_API_KEY) is not set — '
      + 'configure credentials or select a different MARKET_DATA_PROVIDER.',
    );
  }
  const cacheKey = `${cfg.baseUrl}|${cfg.apiKey}|${cfg.timeoutMs}`;
  if (_httpClient && _httpClientForKey === cacheKey) return _httpClient;

  const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: HTTP_AGENT_MAX_SOCKETS,
    maxFreeSockets: 10,
    timeout: cfg.timeoutMs,
  };
  _httpClient = axios.create({
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    httpsAgent: new HttpsAgent(agentOpts),
    httpAgent: new HttpAgent(agentOpts),
    headers: {
      [INDIANAPI_AUTH_HEADER]: cfg.apiKey,
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
  });
  _httpClientForKey = cacheKey;
  return _httpClient;
}

/** Test hook — force client rebuild after env changes. */
export function resetIndianApiHttpClientForTests(): void {
  _httpClient = null;
  _httpClientForKey = null;
}

// ── Retry-After parsing ────────────────────────────────────────────

const DEFAULT_RETRY_AFTER_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfterMs(headerValue: unknown): number {
  if (headerValue == null) return DEFAULT_RETRY_AFTER_MS;
  const raw = String(headerValue).trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

// ── Endpoint groups (rate-limit buckets) ───────────────────────────

const ENDPOINT_GROUP: Record<EndpointName, IndianApiEndpointGroup> = {
  stockDetail: 'stock',
  nseBatchQuote: 'stock',
  trending: 'discovery',
  nseMostActive: 'discovery',
  bseMostActive: 'discovery',
  priceShockers: 'discovery',
  fiftyTwoWeekHL: 'discovery',
  industrySearch: 'discovery',
  corporateActions: 'discovery',
  historical: 'historical',
  historicalStats: 'historical',
  usage: 'meta',
};

// ── Core call ──────────────────────────────────────────────────────

interface CallOptions {
  params?: Record<string, string>;
  bodySymbols?: string[];
  symbol?: string;
  sourceJob?: string;
}

async function call<T>(name: EndpointName, opts: CallOptions = {}): Promise<T> {
  const spec = INDIANAPI_ENDPOINTS[name];

  if (!isEndpointAvailable(spec.path)) {
    const reason = getEndpointUnavailableReason(spec.path) ?? 'endpoint marked unavailable';
    throw new IndianApiHttpError(
      `IndianAPI endpoint ${spec.path} unavailable (cooldown): ${reason}`,
      404,
      false,
    );
  }

  // Budget gate BEFORE consuming a rate-limit slot.
  await checkApiBudget();

  const limiter = getIndianApiRateLimiter();
  await limiter.acquire(ENDPOINT_GROUP[name]);

  const started = Date.now();
  let statusCode: number | null = null;
  let success = false;
  let errorMessage: string | null = null;

  try {
    const client = http();
    const response = spec.method === 'POST'
      ? await client.post<T>(spec.path, { [INDIANAPI_BATCH_BODY_KEY]: opts.bodySymbols ?? [] }, { params: opts.params })
      : await client.get<T>(spec.path, { params: opts.params });

    statusCode = response.status;
    success = true;
    noteEndpointSuccess(spec.path);
    return response.data;
  } catch (err) {
    if (err instanceof IndianApiConfigError) throw err;

    const axiosErr = err as AxiosError;
    statusCode = axiosErr.response?.status ?? null;
    // Never echo axios config (contains the auth header) into logs.
    errorMessage = axiosErr.message ?? String(err);

    if (statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(axiosErr.response?.headers?.['retry-after']);
      limiter.pauseFor(retryAfterMs);
      log.warn('IndianAPI 429 — pausing ingestion queue', {
        endpoint: spec.path,
        retry_after_ms: retryAfterMs,
      });
      throw new IndianApiRateLimitError(retryAfterMs, spec.path);
    }
    if (statusCode === 404) {
      markEndpointUnavailable(spec.path, 'HTTP 404');
      throw new IndianApiHttpError(`IndianAPI 404 on ${spec.path}`, 404, false);
    }
    if (statusCode === 401 || statusCode === 403) {
      throw new IndianApiConfigError(
        `IndianAPI auth failed (HTTP ${statusCode}) on ${spec.path} — check INDIANAPI_API_KEY and plan host.`,
      );
    }
    const transient = statusCode == null || statusCode >= 500;
    throw new IndianApiHttpError(
      `IndianAPI ${spec.method} ${spec.path} failed: ${errorMessage}`,
      statusCode,
      transient,
    );
  } finally {
    limiter.release();
    recordIndianApiRequest({ ok: success, rateLimited: statusCode === 429 });
    // Count every dispatched round-trip (success or failure) — the
    // upstream bills the attempt either way.
    await incrementApiUsage(1).catch(() => {});
    await logProviderRequest({
      provider: INDIANAPI_PROVIDER_NAME,
      endpoint: spec.path,
      symbol: opts.symbol ?? null,
      statusCode,
      success,
      errorMessage: errorMessage?.slice(0, 512) ?? null,
      sourceJob: opts.sourceJob ?? null,
      requestedAt: new Date(started),
    }).catch(() => {});
  }
}

// ── Public adapter surface (ingestion-facing) ──────────────────────

export interface StockDetailResult {
  snapshot: MarketSnapshot;
  intel: CorporateIntel;
}

/** One /stock call yields both the quote snapshot AND the company
 *  profile — ingestion persists both to amortize the request. */
export async function getStockDetail(symbol: string, sourceJob?: string): Promise<StockDetailResult> {
  const raw = await call<RawIndianApiStock>('stockDetail', {
    params: { name: symbol },
    symbol,
    sourceJob,
  });
  return {
    snapshot: mapStockToSnapshot(symbol, raw),
    intel: mapStockToCorporateIntel(symbol, raw),
  };
}

export interface BatchQuotesResult {
  snapshots: MarketSnapshot[];
  missing: string[];
}

/** Batch live prices — only valid when the batch endpoint probes OK. */
export async function getBatchQuotes(symbols: string[], sourceJob?: string): Promise<BatchQuotesResult> {
  const raw = await call<RawIndianApiBatchQuoteItem[] | Record<string, RawIndianApiBatchQuoteItem>>(
    'nseBatchQuote',
    { bodySymbols: symbols, sourceJob },
  );

  const items: RawIndianApiBatchQuoteItem[] = Array.isArray(raw)
    ? raw
    : Object.entries(raw ?? {}).map(([sym, item]) => ({ symbol: sym, ...item }));

  const snapshots: MarketSnapshot[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const snap = mapBatchItemToSnapshot(item);
    if (snap) {
      snapshots.push(snap);
      seen.add(snap.symbol);
    }
  }
  const missing = symbols.map(s => s.toUpperCase()).filter(s => !seen.has(s));
  return { snapshots, missing };
}

/**
 * Probe the batch endpoint with a tiny payload. Returns true when the
 * route exists on this plan/host. A 404 marks the endpoint unavailable
 * (cooldown) so waves fall back to per-symbol calls.
 */
export async function probeBatchEndpoint(sampleSymbols: string[]): Promise<boolean> {
  try {
    await getBatchQuotes(sampleSymbols.slice(0, 2), 'batch-probe');
    return true;
  } catch (err) {
    if (err instanceof IndianApiHttpError && err.statusCode === 404) return false;
    // Rate-limited / transient — treat as unknown, caller decides.
    throw err;
  }
}

export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
  sourceJob?: string,
): Promise<HistoricalSeries> {
  const raw = await call<RawIndianApiHistorical>('historical', {
    params: {
      stock_name: symbol,
      period: rangeToPeriod(range),
      filter: 'price',
    },
    symbol,
    sourceJob,
  });
  return mapHistorical(symbol, range, raw);
}

/** Movers from discovery endpoints — 2 requests, not a 3k-symbol scan. */
export async function getMovers(sourceJob?: string): Promise<MoversResult> {
  const trending = await call<RawIndianApiTrending>('trending', { sourceJob });
  let mostActive: RawIndianApiMostActive = [];
  try {
    mostActive = await call<RawIndianApiMostActive>('nseMostActive', { sourceJob });
  } catch (err) {
    // Most-active is enrichment — trending alone still yields movers.
    log.warn('IndianAPI NSE_most_active failed; serving trending-only movers', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return mapTrendingToMovers(trending, mostActive);
}

/** Vendor-reported quota consumption (metrics / alerting). */
export async function getVendorUsage(sourceJob?: string): Promise<RawIndianApiUsage> {
  return call<RawIndianApiUsage>('usage', { sourceJob });
}
