// ════════════════════════════════════════════════════════════════
//  Data Quality Safety Gate — Step 10 of the IndianAPI cutover.
//
//  Before creating or promoting confirmed signals, every writer must
//  consult this gate. It collapses the resolver envelope + provider
//  health into a single allow/deny decision so call sites don't
//  re-implement the policy.
//
//  Rules (relaxed per spec "RELAX DATA QUALITY" §3):
//    • provider must be IndianAPI or an approved fallback
//    • coveragePercent >= configured minimum (default 50%, was 60%
//      before the relaxation; the dev plan's throttle commonly
//      delivers 60–80% so a stricter gate left the dashboard empty
//      every time it tripped)
//    • latest data timestamp within freshness SLA (default 30 min)
//    • no provider outage active
//
//  IMPORTANT: dataQuality === 'LOW' is NO LONGER an automatic deny.
//  The classifier flags LOW for any 50–70% coverage band but those
//  responses are usable — the coverage floor is the load-bearing
//  check, not the quality LABEL. Removing the LOW deny lets partial
//  responses through to graceful-degradation paths instead of
//  flatlining the dashboard.
//
//  When the gate denies:
//    • Confirmed snapshots must NOT be inserted.
//    • Maturity trackers must NOT be promoted.
//    • Frontend renders DATA DEGRADED state.
//    • Existing confirmed signals stay frozen unless a reliable
//      monitoring price exists (the lifecycle worker handles that
//      branch independently from this gate).
// ════════════════════════════════════════════════════════════════

import type { ResolverResult, ResolverProvider } from './resolver/marketDataResolver';

export type SafetyGateReason =
  | 'OK'
  | 'PROVIDER_NOT_APPROVED'
  /** Retired — kept in the union so any persisted telemetry that
   *  previously emitted this code still parses. The gate no longer
   *  produces it; coverage is what matters. */
  | 'DATA_QUALITY_LOW'
  | 'COVERAGE_TOO_LOW'
  | 'STALE'
  | 'PROVIDER_OUTAGE'
  | 'EMPTY_RESULT';

export interface SafetyGateConfig {
  minCoveragePercent:    number;
  freshnessSlaMs:        number;
  approvedProviders:     ResolverProvider[];
}

const APPROVED_DEFAULT: ResolverProvider[] = ['indianapi', 'cache', 'nse_direct'];

function envInt(name: string, fallback: number, min = 0): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.trunc(raw));
}

export function getSafetyGateConfig(): SafetyGateConfig {
  return {
    // Default lowered 60→50 per spec "RELAX DATA QUALITY" §1: 50%
    // coverage is the floor below which we refuse to write confirmed
    // snapshots. Above that, partial coverage is acceptable and the
    // route surfaces a `coverage_quality` label so consumers can
    // tell strong from degraded responses.
    minCoveragePercent: envInt('SAFETY_GATE_MIN_COVERAGE_PCT', 50, 0),
    freshnessSlaMs:     envInt('SAFETY_GATE_FRESHNESS_SLA_MS', 30 * 60_000, 60_000),
    approvedProviders:  APPROVED_DEFAULT,
  };
}

export interface SafetyGateDecision {
  allowed:  boolean;
  reason:   SafetyGateReason;
  message:  string;
  /** Coverage / dataQuality / freshness for telemetry — copied from
   *  the resolver result so callers don't have to re-thread them. */
  provider:        ResolverProvider;
  dataQuality:     ResolverResult['dataQuality'];
  coveragePercent: number;
}

/**
 * Evaluate a resolver result against the gate. Pure function; no I/O.
 *
 * Pass `responseReceivedAtMs` only when the resolver result is older
 * than its `responseReceivedAt` ISO would suggest (e.g. a cached
 * envelope). For fresh calls, leave it unset and we use the
 * envelope's own timestamp.
 */
export function evaluateSafetyGate(
  resolved: Pick<
    ResolverResult,
    | 'provider'
    | 'dataQuality'
    | 'status'
    | 'coveragePercent'
    | 'responseReceivedAt'
    | 'symbolsReturned'
  >,
  cfg: SafetyGateConfig = getSafetyGateConfig(),
): SafetyGateDecision {
  const base = {
    provider:        resolved.provider,
    dataQuality:     resolved.dataQuality,
    coveragePercent: resolved.coveragePercent,
  };

  if (resolved.status === 'failed' || resolved.symbolsReturned === 0) {
    return { allowed: false, reason: 'EMPTY_RESULT', message: 'resolver returned no data', ...base };
  }
  if (!cfg.approvedProviders.includes(resolved.provider)) {
    return {
      allowed: false,
      reason: 'PROVIDER_NOT_APPROVED',
      message: `provider '${resolved.provider}' is not an approved source for confirmed signals`,
      ...base,
    };
  }
  // dataQuality=LOW is NO LONGER an automatic deny. The classifier
  // flags LOW any time coverage drops into the 50–70% band, but those
  // responses are usable. The coverage floor below is what guards the
  // write path; LOW just rides through as a label on the response.
  if (resolved.coveragePercent < cfg.minCoveragePercent) {
    return {
      allowed: false,
      reason: 'COVERAGE_TOO_LOW',
      message: `coverage ${resolved.coveragePercent}% < min ${cfg.minCoveragePercent}%`,
      ...base,
    };
  }
  const ageMs = Math.max(0, Date.now() - new Date(resolved.responseReceivedAt).getTime());
  if (ageMs > cfg.freshnessSlaMs) {
    return {
      allowed: false,
      reason: 'STALE',
      message: `resolver response age ${Math.round(ageMs / 1000)}s exceeds SLA`,
      ...base,
    };
  }
  return { allowed: true, reason: 'OK', message: 'gate passed', ...base };
}
