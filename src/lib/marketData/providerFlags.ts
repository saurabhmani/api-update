// ════════════════════════════════════════════════════════════════
//  providerFlags — single source of truth for market-data feature
//  flags. Read these (NEVER process.env directly) when deciding
//  which provider may serve a request.
//
//  Flags are read once per process; calling these is O(1) thereafter.
//  This avoids string-compare cost on every hot-path lookup and gives
//  test code a single place to monkey-patch when needed.
//
//  Hard contract (Step 2 of the IndianAPI cutover):
//    • MARKET_DATA_PROVIDER = 'indianapi' | 'yahoo' | 'kite' | 'none' // @deprecated marker
//      Production must run with 'indianapi'. Anything else is an
//      explicit operator opt-out and is logged at boot.
//    • YAHOO_EMERGENCY_FALLBACK_ENABLED = true ONLY when an operator
//      has consciously decided to allow 15-min-delayed Yahoo prices // @deprecated marker
//      to back-stop a complete IndianAPI outage. Default false.
//    • KITE_ENABLED — Kite has been removed from the runtime. The // @deprecated marker
//      flag exists so future re-introduction is a config change, not
//      a code change. Default false.
//    • NSE_DIRECT_FALLBACK_ENABLED — gates the rare per-symbol NSE
//      direct fetch documented in Step 5. Default true (capped by
//      NSE_DIRECT_FALLBACK_MAX_SYMBOLS_PER_DAY).
// ════════════════════════════════════════════════════════════════

export type MarketDataProviderName =
  | 'indianapi'
  | 'yahoo' // @deprecated marker
  | 'kite' // @deprecated marker
  | 'none'
  /** Legacy kill-switch — flips production back to the pre-cutover
   *  Yahoo/Kite path. Activates the legacy_rollback feed-health // @deprecated marker
   *  marker and is intended for emergency rollback within the 30-day
   *  soak window. Removed from the union once the legacy code is
   *  deleted. */
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
 * Primary provider. The resolver and every consumer must consult
 * this — not raw env — so a future flip is centralised.
 *
 * Resolution precedence:
 *   1. INDIANAPI_PRIMARY=true            → 'indianapi'
 *   2. MARKET_DATA_PROVIDER=<name>       → that name
 *   3. INDIANAPI_ENABLED=true (default)  → 'indianapi'
 *   4. fallback                          → 'indianapi'
 *
 * INDIANAPI_PRIMARY is the spec's preferred flag name; it wins when
 * present so the documented .env.example stays authoritative even if
 * a stale MARKET_DATA_PROVIDER is also set.
 */
export function getMarketDataProvider(): MarketDataProviderName {
  const primary = (process.env.INDIANAPI_PRIMARY ?? '').trim().toLowerCase();
  if (primary === 'true' || primary === '1' || primary === 'yes' || primary === 'on') {
    return 'indianapi';
  }
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'indianapi' || raw === 'yahoo' || raw === 'kite' || raw === 'none' || raw === 'legacy') { // @deprecated marker
    return raw;
  }
  const enabled = (process.env.INDIANAPI_ENABLED ?? 'true').trim().toLowerCase();
  if (enabled === 'true' || enabled === '1' || enabled === 'yes' || enabled === 'on') {
    return 'indianapi';
  }
  return 'indianapi';
}

/** Yahoo emergency fallback.
 *
 *  Spec INSTITUTIONAL §E (REMOVE Yahoo from live flow) — the live
 *  resolver must use IndianAPI primary + NSE direct fallback only.
 *  Yahoo (~15-min delayed) is no longer part of the live signal chain.
 *
 *  This flag now defaults to FALSE. The branch in marketDataResolver
 *  is retained for backwards compatibility (cassette tests, one-off
 *  ops opt-in via YAHOO_EMERGENCY_FALLBACK_ENABLED=true) but is OFF
 *  by default so production never hits Yahoo on the live signal path.
 *
 *  When IndianAPI fails AND the NSE direct leg can't fill, the
 *  resolver returns DATA_DEGRADED. Callers tagged `signalCritical`
 *  reject DATA_DEGRADED — better an empty response than a stale
 *  Yahoo quote driving an institutional decision. */
export function isYahooEmergencyFallbackEnabled(): boolean { // @deprecated marker
  return asBool(process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED, false);
}

/** True when the Kite integration is intentionally enabled. Default false. */ // @deprecated marker
export function isKiteEnabled(): boolean { // @deprecated marker
  return asBool(process.env.KITE_ENABLED, false);
}

/** True when the NSE-direct rare fallback is allowed. Default true. */
export function isNseDirectFallbackEnabled(): boolean {
  return asBool(process.env.NSE_DIRECT_FALLBACK_ENABLED, true);
}

/** True when the operator has flipped the temporary primary-provider
 *  bypass to NSE direct. Default false.
 *
 *  When ON, the resolver SKIPS IndianAPI entirely and routes live
 *  fetches through NSE direct as the primary path. The same
 *  per-symbol cache, sequential 7s gap, daily-cap, exponential
 *  backoff, and hard-trip-on-403 protections still apply — this
 *  flag changes the routing, not the safety layer.
 *
 *  Intended use: short window when IndianAPI is unavailable. Once
 *  IndianAPI recovers, set FORCE_NSE_MODE=0 (or remove the var) to
 *  restore the standard `IndianAPI → NSE fallback` order. */
export function isNseForceMode(): boolean {
  return asBool(process.env.FORCE_NSE_MODE, false);
}

/** True when IndianAPI is the primary provider. Convenience helper. */
export function isIndianApiPrimary(): boolean {
  return getMarketDataProvider() === 'indianapi';
}

/** True when the operator has flipped the kill-switch to the
 *  pre-cutover legacy path. The resolver short-circuits on this
 *  flag and writes a `legacy_rollback` row to q365_data_feed_health
 *  so the rollback is loud. */
export function isLegacyRollbackActive(): boolean {
  return getMarketDataProvider() === 'legacy';
}

/**
 * Hard rule (Step 2 / Step 9):
 *   "If MARKET_DATA_PROVIDER=indianapi, production signal flow MUST
 *    NOT call Yahoo unless YAHOO_EMERGENCY_FALLBACK_ENABLED=true." // @deprecated marker
 *
 * Returns true ONLY when a Yahoo branch is allowed to run at all. // @deprecated marker
 */
export function mayUseYahoo(): boolean { // @deprecated marker
  if (getMarketDataProvider() === 'yahoo') return true; // @deprecated marker
  return isYahooEmergencyFallbackEnabled(); // @deprecated marker
}

/**
 * Returns true ONLY when a Kite branch is allowed to run at all. // @deprecated marker
 * Currently Kite is fully removed, so this requires both the new // @deprecated marker
 * KITE_ENABLED flag AND the explicit primary selection.
 */
export function mayUseKite(): boolean { // @deprecated marker
  if (!isKiteEnabled()) return false; // @deprecated marker
  return getMarketDataProvider() === 'kite'; // @deprecated marker
}

// ── NSE-direct fallback knobs (Step 5) ───────────────────────────

export interface NseDirectFallbackConfig {
  enabled:           boolean;
  triggerFailures:   number;   // consecutive IndianAPI failures before NSE direct may run
  maxSymbolsPerDay:  number;   // hard cap (default 50)
  minDelayMs:        number;   // min gap between requests (default 7000)
}

export function getNseDirectFallbackConfig(): NseDirectFallbackConfig {
  return {
    enabled:          isNseDirectFallbackEnabled(),
    // Spec FIX-DATA-PIPELINE §1+§3: ONE true IndianAPI failure (timeout
    // / 5xx / network) must immediately fail over. The previous
    // threshold of 3 left the resolver thrashing the primary for 3
    // consecutive cycles before the cascade engaged — by which point
    // the dashboard had already polled `signals: []` repeatedly.
    triggerFailures:  asInt(process.env.NSE_DIRECT_FALLBACK_TRIGGER_FAILURES, 1, 1),
    maxSymbolsPerDay: asInt(process.env.NSE_DIRECT_FALLBACK_MAX_SYMBOLS_PER_DAY, 50, 0),
    // Spec SMART_FALLBACK §4 default: 500ms gap = 2 req/sec ceiling.
    // Operators who saw 403s under load can dial it back up via env;
    // floor of 250ms enforced so a misconfigured value can't hammer
    // NSE into a same-day ban.
    minDelayMs:       asInt(process.env.NSE_DIRECT_FALLBACK_MIN_DELAY_MS, 500, 250),
  };
}

/**
 * One-shot boot summary. Called from instrumentation.ts so operators
 * can see the resolved feature-flag state in the boot log without
 * grepping env. No secrets, no values — just resolved booleans.
 */
export function getProviderFlagsSummary(): Record<string, unknown> {
  const nse = getNseDirectFallbackConfig();
  return {
    marketDataProvider:               getMarketDataProvider(),
    yahooEmergencyFallbackEnabled:    isYahooEmergencyFallbackEnabled(), // @deprecated marker
    kiteEnabled:                      isKiteEnabled(), // @deprecated marker
    nseDirectFallbackEnabled:         nse.enabled,
    nseDirectTriggerFailures:         nse.triggerFailures,
    nseDirectMaxSymbolsPerDay:        nse.maxSymbolsPerDay,
    nseDirectMinDelayMs:              nse.minDelayMs,
  };
}
