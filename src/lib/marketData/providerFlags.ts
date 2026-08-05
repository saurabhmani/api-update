/**
 * providerFlags — system-level market-data feature flags for
 * background jobs, boot, and broker-neutral warehouse paths.
 *
 * IndianAPI is the sole market-data upstream. Kite/Zerodha/Shoonya are
 * not selectable primaries. Env MARKET_DATA_PROVIDER=kite|zerodha is
 * rejected (resolves to `none` with a one-time warning).
 *
 * USER-FACING requests must NOT call getMarketDataProvider /
 * getLiveFeedProvider to pick Zerodha vs Shoonya.
 */

import { logger } from '@/lib/logger';

/** Active / selectable system market-data primaries. */
export type ActiveMarketDataProvider = 'indianapi';

/** Selectable system primaries for jobs / boot. */
export type MarketDataProviderName =
  | ActiveMarketDataProvider
  | 'yahoo'
  | 'none'
  | 'legacy';

function asBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function asInt(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

/**
 * IndianAPI feature flag. Default OFF — must be explicitly enabled
 * before IndianAPI can be selected or bootstrap-defaulted.
 */
export function isIndianApiEnabled(): boolean {
  return asBool(process.env.INDIANAPI_ENABLED, false);
}

/**
 * True when an IndianAPI key is present in the environment.
 * Never logs or returns the key itself.
 */
export function indianApiCredentialsPresent(): boolean {
  const key = (
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || ''
  );
  return key.length > 0;
}

const flagsLog = logger.child({ component: 'providerFlags' });
let kiteAliasWarned = false;

/**
 * SYSTEM-LEVEL primary provider (background jobs / boot only).
 *
 * Resolution order:
 *   1. Explicit MARKET_DATA_PROVIDER — only indianapi|yahoo|none|legacy.
 *      kite|zerodha|shoonya|finvasia → `none` + one-time warning.
 *   2. Unset / empty → bootstrap default `indianapi` when the feature
 *      flag is on AND credentials are present.
 *   3. Otherwise `none`.
 */
export function getSystemMarketDataProvider(): MarketDataProviderName {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();

  if (
    raw === 'kite'
    || raw === 'zerodha'
    || raw === 'shoonya'
    || raw === 'finvasia'
    || raw === 'noren'
  ) {
    if (!kiteAliasWarned) {
      kiteAliasWarned = true;
      flagsLog.warn(
        'MARKET_DATA_PROVIDER broker value is unsupported — set indianapi',
        { env: 'MARKET_DATA_PROVIDER', value: raw },
      );
    }
    return 'none';
  }
  if (raw === 'yahoo' || raw === 'indianapi' || raw === 'none' || raw === 'legacy') {
    return raw;
  }
  if (raw === '' && isIndianApiEnabled() && indianApiCredentialsPresent()) {
    return 'indianapi';
  }
  return 'none';
}

/** True when IndianAPI was bootstrap-defaulted (no explicit selection). */
export function isIndianApiBootstrapDefault(): boolean {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  return raw === '' && getSystemMarketDataProvider() === 'indianapi';
}

/**
 * @deprecated Prefer getSystemMarketDataProvider() for jobs, or
 * getUserActiveDataSource(userId) for user-facing paths.
 */
export function getMarketDataProvider(): MarketDataProviderName {
  return getSystemMarketDataProvider();
}

export function getPrimaryFallbackProvider(
  selected: MarketDataProviderName = getSystemMarketDataProvider(),
): string {
  switch (selected) {
    case 'yahoo':
      return 'nse|db';
    case 'indianapi':
      // Serve path is cache → DB only; ingestion keeps them fresh.
      return 'cache|db';
    case 'legacy':
      return 'legacy_path';
    case 'none':
      return 'none';
    default:
      return 'none';
  }
}

export type ProviderCapabilityTag =
  | 'quotes'
  | 'batch_quotes'
  | 'historical'
  | 'movers'
  | 'trending'
  | 'news'
  | 'corporate'
  | 'fundamentals'
  | 'search';

/** @deprecated Kite is no longer a market-data upstream. Kept for test/compat. */
export const KITE_SUPPORTED_CAPABILITIES: readonly ProviderCapabilityTag[] = [
  'quotes',
  'batch_quotes',
  'historical',
  'search',
] as const;

export function isKiteSupportedCapability(cap: ProviderCapabilityTag): boolean {
  return (KITE_SUPPORTED_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * Yahoo emergency cascade for SYSTEM resolver paths.
 * Default OFF — must be explicitly enabled (Phase 11).
 */
export function isYahooEmergencyFallbackEnabled(): boolean {
  return asBool(process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED, false);
}

/** @deprecated Kite market-data path removed — always false unless explicitly forced. */
export function isKiteEnabled(): boolean {
  return asBool(process.env.KITE_ENABLED, false);
}

/** NSE-direct cascade for SYSTEM resolver. Default OFF (Phase 11). */
export function isNseDirectFallbackEnabled(): boolean {
  return asBool(process.env.NSE_DIRECT_FALLBACK_ENABLED, false);
}

export function isNseForceMode(): boolean {
  return asBool(process.env.FORCE_NSE_MODE, false);
}

/** @deprecated Always false — vendor removed. */
export function isLegacyVendorPrimary(): boolean {
  return false;
}

/** Always false — Kite is never the system market-data primary. */
export function isKitePrimary(): boolean {
  return false;
}

/** System-level: is IndianAPI the active warehouse provider? */
export function isIndianApiPrimary(): boolean {
  return getSystemMarketDataProvider() === 'indianapi';
}

// ── IndianAPI ingestion configuration ──────────────────────────────
//
// All knobs for the rate-limit-safe ingestion pipeline. Retries are a
// secondary safety net — the primary controls are the RPS token bucket,
// bounded concurrency, and per-run budget caps.

export interface IndianApiIngestConfig {
  enabled: boolean;
  /** Max concurrent in-flight upstream requests. */
  maxConcurrency: number;
  /** Symbols per batch call when the batch endpoint is available. */
  batchSize: number;
  /** 'auto' probes the batch endpoint; 'on'/'off' force it. */
  batchMode: 'auto' | 'on' | 'off';
  /** Global requests-per-second ceiling across all endpoints. */
  rpsGlobal: number;
  /** Max retry attempts per item (transient failures only). */
  maxRetries: number;
  /** Base backoff delay in ms (exponential + full jitter). */
  retryBaseMs: number;
  /** Per-run hard cap on upstream calls. */
  perRunLimit: number;
  /** Daily soft budget (degrade) / monthly hard budget (freeze). */
  dailySoftLimit: number;
  monthlyLimit: number;
  /** Staging subset: 0 = full active universe. */
  ingestSymbolLimit: number;
  /** Distributed ingest-lock TTL in seconds. */
  lockTtlS: number;
  /** Circuit breaker: consecutive failures to open, cooldown ms. */
  circuitFailures: number;
  circuitCooldownMs: number;
}

const DEFAULT_INDIAN_API_RPS = 10;
const warnedRpsKeys = new Set<string>();

function warnRpsOnce(key: string, message: string, meta: Record<string, unknown>): void {
  if (warnedRpsKeys.has(key)) return;
  warnedRpsKeys.add(key);
  flagsLog.warn(message, meta);
}

/** @internal Test hook — reset one-shot RPS config warnings. */
export function resetIndianApiRpsWarningsForTests(): void {
  warnedRpsKeys.clear();
  kiteAliasWarned = false;
}

function parseIndianApiRpsEnv(
  raw: string | undefined,
  envName: string,
): number | null {
  if (raw == null || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    warnRpsOnce(
      `${envName}:invalid`,
      'Invalid IndianAPI requests-per-second — using default',
      { envName, value: trimmed, default: DEFAULT_INDIAN_API_RPS },
    );
    return null;
  }
  const resolved = Math.max(1, Math.trunc(n));
  if (!Number.isInteger(n)) {
    warnRpsOnce(
      `${envName}:non_integer`,
      'Non-integer IndianAPI requests-per-second — truncating',
      { envName, value: trimmed, resolved },
    );
  }
  return resolved;
}

/** Global IndianAPI RPS — INDIAN_API_REQUESTS_PER_SECOND (default 10); INDIANAPI_RPS_GLOBAL is a legacy alias. */
export function getIndianApiRequestsPerSecond(): number {
  const primary = parseIndianApiRpsEnv(
    process.env.INDIAN_API_REQUESTS_PER_SECOND,
    'INDIAN_API_REQUESTS_PER_SECOND',
  );
  if (primary != null) return primary;

  const legacy = parseIndianApiRpsEnv(
    process.env.INDIANAPI_RPS_GLOBAL,
    'INDIANAPI_RPS_GLOBAL',
  );
  if (legacy != null) return legacy;

  return DEFAULT_INDIAN_API_RPS;
}
export function getIndianApiIngestConfig(): IndianApiIngestConfig {
  const batchRaw = (process.env.INDIANAPI_BATCH_ENABLED ?? 'auto').trim().toLowerCase();
  const batchMode: 'auto' | 'on' | 'off' =
    batchRaw === 'on' || batchRaw === 'true' || batchRaw === '1' ? 'on'
      : batchRaw === 'off' || batchRaw === 'false' || batchRaw === '0' ? 'off'
        : 'auto';
  return {
    enabled: isIndianApiEnabled(),
    maxConcurrency: asInt(process.env.INDIANAPI_MAX_CONCURRENCY, 3, 1),
    batchSize: asInt(process.env.INDIANAPI_BATCH_SIZE, 25, 1),
    batchMode,
    rpsGlobal: getIndianApiRequestsPerSecond(),
    maxRetries: asInt(process.env.INDIANAPI_MAX_RETRIES, 3, 0),
    retryBaseMs: asInt(process.env.INDIANAPI_RETRY_BASE_MS, 500, 100),
    perRunLimit: asInt(process.env.INDIANAPI_PER_RUN_LIMIT, 1500, 1),
    dailySoftLimit: asInt(process.env.INDIANAPI_DAILY_SOFT_LIMIT, 4500, 1),
    monthlyLimit: asInt(process.env.INDIANAPI_MONTHLY_LIMIT, 100_000, 1),
    ingestSymbolLimit: asInt(process.env.INDIANAPI_INGEST_SYMBOL_LIMIT, 0, 0),
    lockTtlS: asInt(process.env.INDIANAPI_LOCK_TTL_S, 900, 60),
    circuitFailures: asInt(process.env.INDIANAPI_CIRCUIT_FAILURES, 5, 1),
    circuitCooldownMs: asInt(process.env.INDIANAPI_CIRCUIT_COOLDOWN_MS, 30_000, 1_000),
  };
}

export function isLegacyRollbackActive(): boolean {
  return getSystemMarketDataProvider() === 'legacy';
}

export function mayUseYahoo(): boolean {
  if (getSystemMarketDataProvider() === 'yahoo') return true;
  return isYahooEmergencyFallbackEnabled();
}

export type LiveFeedProvider = 'yahoo' | 'none';

/**
 * SYSTEM-LEVEL live WS/poll upstream. No Kite WebSocket — IndianAPI
 * does not support live ticks. Yahoo only when explicitly selected.
 */
export function getSystemLiveFeedProvider(): LiveFeedProvider {
  const selected = getSystemMarketDataProvider();
  if (selected === 'yahoo') return 'yahoo';
  return 'none';
}

/** @deprecated Prefer getSystemLiveFeedProvider() for jobs. */
export function getLiveFeedProvider(): LiveFeedProvider {
  return getSystemLiveFeedProvider();
}

/** Always false — Kite is not used for market data. */
export function mayUseKite(): boolean {
  return false;
}

export interface NseDirectFallbackConfig {
  enabled: boolean;
  triggerFailures: number;
  maxSymbolsPerDay: number;
  minDelayMs: number;
}

export function getNseDirectFallbackConfig(): NseDirectFallbackConfig {
  return {
    enabled: isNseDirectFallbackEnabled(),
    triggerFailures: asInt(process.env.NSE_DIRECT_FALLBACK_TRIGGER_FAILURES, 1, 1),
    maxSymbolsPerDay: asInt(process.env.NSE_DIRECT_FALLBACK_MAX_SYMBOLS_PER_DAY, 50, 0),
    minDelayMs: asInt(process.env.NSE_DIRECT_FALLBACK_MIN_DELAY_MS, 500, 250),
  };
}

export function isDualSourceEnabled(): boolean {
  return false;
}

export function getDualSourceConfig(): import('@/lib/marketData/dualSource/types').DualSourceConfig {
  return {
    enabled: false,
    priceToleranceBps: asInt(process.env.DUAL_SOURCE_PRICE_TOLERANCE_BPS, 50, 1),
    volumeTolerancePct: asInt(process.env.DUAL_SOURCE_VOLUME_TOLERANCE_PCT, 25, 0),
    timestampToleranceMs: asInt(process.env.DUAL_SOURCE_TIMESTAMP_TOLERANCE_MS, 120_000, 5_000),
    outlierSpikeBps: asInt(process.env.DUAL_SOURCE_OUTLIER_SPIKE_BPS, 200, 10),
    allowSingleSourceSignals: asBool(process.env.DUAL_SOURCE_ALLOW_SINGLE_SOURCE, false),
    authoritativeOnConflict: (() => {
      // Dual-source is permanently disabled; keep type-compatible null.
      const raw = (process.env.DUAL_SOURCE_AUTHORITATIVE ?? '').trim().toLowerCase();
      if (raw === 'yahoo') return 'yahoo' as const;
      return null;
    })() as import('@/lib/marketData/dualSource/types').FeedSourceId | null,
    minConfidenceForSignal: asInt(process.env.DUAL_SOURCE_MIN_CONFIDENCE, 80, 0),
    yahooConcurrency: asInt(process.env.YAHOO_LIVE_CONCURRENCY, 10, 1),
    kiteConcurrency: 0,
  };
}

export function getProviderFlagsSummary(): Record<string, unknown> {
  const nse = getNseDirectFallbackConfig();
  const dual = getDualSourceConfig();
  const selected = getSystemMarketDataProvider();
  const rawEnv = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  return {
    marketDataProvider: selected,
    systemMarketDataProvider: selected,
    note: 'IndianAPI is the sole market-data upstream; broker MARKET_DATA_PROVIDER values resolve to none',
    kitePrimary: false,
    kiteEnvAliased: rawEnv === 'kite' || rawEnv === 'zerodha'
      || rawEnv === 'shoonya' || rawEnv === 'finvasia' || rawEnv === 'noren',
    indianApiPrimary: selected === 'indianapi',
    indianApiEnabled: isIndianApiEnabled(),
    indianApiBootstrapDefault: isIndianApiBootstrapDefault(),
    indianApiCredentialsConfigured: indianApiCredentialsPresent(),
    primaryFallbackProvider: getPrimaryFallbackProvider(selected),
    liveFeedProvider: getSystemLiveFeedProvider(),
    dualSourceEnabled: dual.enabled,
    yahooEmergencyFallbackEnabled: isYahooEmergencyFallbackEnabled(),
    kiteEnabled: isKiteEnabled(),
    nseDirectFallbackEnabled: nse.enabled,
    nseDirectTriggerFailures: nse.triggerFailures,
    nseDirectMaxSymbolsPerDay: nse.maxSymbolsPerDay,
    nseDirectMinDelayMs: nse.minDelayMs,
    hiddenDefaultsRemoved: true,
    brokersRemovedFromMarketData: true,
  };
}
