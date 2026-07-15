// ════════════════════════════════════════════════════════════════
//  providerFlags — single source of truth for market-data feature
//  flags. Read these (NEVER process.env directly) when deciding
//  which provider may serve a request.
//
//  Hard contract (removed vendor decommission):
//    • MARKET_DATA_PROVIDER = 'yahoo' | 'kite' | 'none' | 'legacy'
//      Production DEFAULT is 'kite' when the env var is unset.
//    • Fallback chain: Kite → Yahoo → NSE → Database.
//    • YAHOO_EMERGENCY_FALLBACK_ENABLED — when true, Yahoo may serve
//      live quotes after Kite miss. Default TRUE after decommission
//      so the cascade is usable without removed vendor.
//    • NSE_DIRECT_FALLBACK_ENABLED — rare per-symbol NSE fetch.
// ════════════════════════════════════════════════════════════════

export type MarketDataProviderName =
  | 'yahoo'
  | 'kite'
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
 * Primary provider.
 *   1. MARKET_DATA_PROVIDER=<name> → that name
 *   2. unset / unrecognized        → 'kite'
 *
 * Legacy env LEGACY_VENDOR_ENV / MARKET_DATA_PROVIDER=legacy_vendor are
 * ignored (map to kite) so decommissioned installs still boot.
 */
export function getMarketDataProvider(): MarketDataProviderName {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'yahoo' || raw === 'kite' || raw === 'none' || raw === 'legacy') {
    return raw;
  }
  // Former "kite" pin → kite (vendor removed).
  return 'kite';
}

export function getPrimaryFallbackProvider(
  selected: MarketDataProviderName = getMarketDataProvider(),
): string {
  switch (selected) {
    case 'kite':
      return 'yahoo|nse|db';
    case 'yahoo':
      return 'nse|db';
    case 'legacy':
      return 'legacy_path';
    case 'none':
      return 'none';
    default:
      return 'yahoo|nse|db';
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

export const KITE_SUPPORTED_CAPABILITIES: readonly ProviderCapabilityTag[] = [
  'quotes',
  'batch_quotes',
  'historical',
  'search',
] as const;

export function isKiteSupportedCapability(cap: ProviderCapabilityTag): boolean {
  return (KITE_SUPPORTED_CAPABILITIES as readonly string[]).includes(cap);
}

/** Yahoo may fill after Kite miss. Default true (decommission cascade). */
export function isYahooEmergencyFallbackEnabled(): boolean {
  return asBool(process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED, true);
}

export function isKiteEnabled(): boolean {
  return asBool(process.env.KITE_ENABLED, true);
}

export function isNseDirectFallbackEnabled(): boolean {
  return asBool(process.env.NSE_DIRECT_FALLBACK_ENABLED, true);
}

export function isNseForceMode(): boolean {
  return asBool(process.env.FORCE_NSE_MODE, false);
}

/** @deprecated Always false — vendor removed. Kept for call-site compile until Phase 3. */
export function isLegacyVendorPrimary(): boolean {
  return false;
}

export function isKitePrimary(): boolean {
  return getMarketDataProvider() === 'kite';
}

export function isLegacyRollbackActive(): boolean {
  return getMarketDataProvider() === 'legacy';
}

export function mayUseYahoo(): boolean {
  if (getMarketDataProvider() === 'yahoo') return true;
  return isYahooEmergencyFallbackEnabled();
}

export type LiveFeedProvider = 'yahoo' | 'kite';

/** Live WS poll upstream. */
export function getLiveFeedProvider(): LiveFeedProvider {
  return isKitePrimary() && isKiteEnabled() ? 'kite' : 'yahoo';
}

export function mayUseKite(): boolean {
  return isKitePrimary();
}

export interface NseDirectFallbackConfig {
  enabled:           boolean;
  triggerFailures:   number;
  maxSymbolsPerDay:  number;
  minDelayMs:        number;
}

export function getNseDirectFallbackConfig(): NseDirectFallbackConfig {
  return {
    enabled:          isNseDirectFallbackEnabled(),
    triggerFailures:  asInt(process.env.NSE_DIRECT_FALLBACK_TRIGGER_FAILURES, 1, 1),
    maxSymbolsPerDay: asInt(process.env.NSE_DIRECT_FALLBACK_MAX_SYMBOLS_PER_DAY, 50, 0),
    minDelayMs:       asInt(process.env.NSE_DIRECT_FALLBACK_MIN_DELAY_MS, 500, 250),
  };
}

export function isDualSourceEnabled(): boolean {
  // Dual-source required the removed vendor; force off.
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
      const raw = (process.env.DUAL_SOURCE_AUTHORITATIVE ?? 'kite').trim().toLowerCase();
      if (raw === 'yahoo') return 'yahoo';
      if (raw === 'kite') return 'kite';
      return 'kite';
    })(),
    minConfidenceForSignal: asInt(process.env.DUAL_SOURCE_MIN_CONFIDENCE, 80, 0),
    yahooConcurrency: asInt(process.env.YAHOO_LIVE_CONCURRENCY, 10, 1),
    kiteConcurrency: 0,
  };
}

export function getProviderFlagsSummary(): Record<string, unknown> {
  const nse = getNseDirectFallbackConfig();
  const dual = getDualSourceConfig();
  const selected = getMarketDataProvider();
  return {
    marketDataProvider:               selected,
    kitePrimary:                      selected === 'kite',
    primaryFallbackProvider:          getPrimaryFallbackProvider(selected),
    liveFeedProvider:                 getLiveFeedProvider(),
    dualSourceEnabled:                dual.enabled,
    yahooEmergencyFallbackEnabled:    isYahooEmergencyFallbackEnabled(),
    kiteEnabled:                      isKiteEnabled(),
    nseDirectFallbackEnabled:         nse.enabled,
    nseDirectTriggerFailures:         nse.triggerFailures,
    nseDirectMaxSymbolsPerDay:        nse.maxSymbolsPerDay,
    nseDirectMinDelayMs:              nse.minDelayMs,
  };
}
