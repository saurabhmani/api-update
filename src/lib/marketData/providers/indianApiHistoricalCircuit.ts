// ════════════════════════════════════════════════════════════════
//  Process-global circuit breaker for IndianAPI *historical* candle
//  fetches (backfill / daily update). Transient 5xx open the breaker
//  only after N consecutive failures; cooldown is short (seconds),
//  never IST-midnight.
//
//  Auth / quota / permanent 4xx do NOT feed this breaker.
//  Local "circuit open" checks do NOT increment quota usage.
// ════════════════════════════════════════════════════════════════

export type CandleUpstreamErrorCategory =
  | 'transient_upstream_503'
  | 'rate_limited_429'
  | 'quota_exhausted'
  | 'authentication_failed'
  | 'unsupported_symbol_series'
  | 'symbol_not_found'
  | 'invalid_response'
  | 'circuit_open'
  | 'network_timeout'
  | 'database_write_failed'
  | 'upstream_error';

export class IndianApiCircuitOpenError extends Error {
  readonly category = 'circuit_open' as const;
  readonly resumeAfterMs: number;
  constructor(resumeAfterMs: number, detail?: string) {
    const resumeIso = new Date(Date.now() + Math.max(0, resumeAfterMs)).toISOString();
    super(
      detail
        ?? `indianapi_circuit_open resume_after=${resumeIso}`,
    );
    this.name = 'IndianApiCircuitOpenError';
    this.resumeAfterMs = Math.max(0, resumeAfterMs);
  }
}

function envInt(name: string, fallback: number, lo: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < lo) return fallback;
  return Math.floor(raw);
}

/** Prefer new names; fall back to existing ingest circuit env. */
export function getIndianApiHistoricalCircuitConfig(): {
  failureThreshold: number;
  cooldownMs: number;
  maxRetries503: number;
} {
  const threshold = envInt(
    'INDIANAPI_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    envInt('INDIANAPI_CIRCUIT_FAILURES', 5, 1),
    1,
  );
  const cooldownSec = envInt('INDIANAPI_CIRCUIT_BREAKER_COOLDOWN_SECONDS', 0, 0);
  const cooldownMs = cooldownSec > 0
    ? cooldownSec * 1000
    : envInt('INDIANAPI_CIRCUIT_COOLDOWN_MS', 60_000, 1_000);
  const maxRetries503 = envInt(
    'INDIANAPI_503_MAX_RETRIES',
    envInt('INDIANAPI_MAX_RETRIES', 3, 0),
    0,
  );
  return { failureThreshold: threshold, cooldownMs, maxRetries503 };
}

let consecutiveFailures = 0;
let openUntilMs = 0;
let breakerTrips = 0;
let locallyBlocked = 0;

export function resetIndianApiHistoricalCircuitForTests(): void {
  consecutiveFailures = 0;
  openUntilMs = 0;
  breakerTrips = 0;
  locallyBlocked = 0;
}

export function getIndianApiHistoricalCircuitState(): {
  open: boolean;
  consecutiveFailures: number;
  failureThreshold: number;
  openUntilMs: number;
  resumeAfterIso: string | null;
  breakerTrips: number;
  locallyBlockedRequests: number;
  cooldownMs: number;
} {
  const cfg = getIndianApiHistoricalCircuitConfig();
  const open = openUntilMs > Date.now();
  return {
    open,
    consecutiveFailures,
    failureThreshold: cfg.failureThreshold,
    openUntilMs,
    resumeAfterIso: open ? new Date(openUntilMs).toISOString() : null,
    breakerTrips,
    locallyBlockedRequests: locallyBlocked,
    cooldownMs: cfg.cooldownMs,
  };
}

export function isIndianApiHistoricalCircuitOpen(): boolean {
  return openUntilMs > Date.now();
}

/**
 * Throws IndianApiCircuitOpenError when open. Does not touch quota.
 * Increments locally_blocked counter for accounting.
 */
export function assertIndianApiHistoricalCircuitAllows(): void {
  const remaining = openUntilMs - Date.now();
  if (remaining <= 0) return;
  locallyBlocked += 1;
  throw new IndianApiCircuitOpenError(remaining);
}

export function noteIndianApiHistoricalSuccess(): void {
  consecutiveFailures = 0;
  // Leave openUntilMs alone if still in cooldown from a prior trip —
  // half-open after cooldown expiry is enough; success clears streak.
  if (openUntilMs > 0 && openUntilMs <= Date.now()) {
    openUntilMs = 0;
  }
}

/**
 * Record a provider-wide transient failure (5xx / network).
 * Returns whether this call opened (or re-opened) the breaker.
 */
export function noteIndianApiHistoricalTransientFailure(): {
  opened: boolean;
  consecutiveFailures: number;
  openUntilMs: number;
} {
  const cfg = getIndianApiHistoricalCircuitConfig();
  consecutiveFailures += 1;
  if (consecutiveFailures < cfg.failureThreshold) {
    return { opened: false, consecutiveFailures, openUntilMs };
  }
  consecutiveFailures = 0;
  openUntilMs = Date.now() + cfg.cooldownMs;
  breakerTrips += 1;
  console.warn(
    `[INDIANAPI CIRCUIT] OPEN trips=${breakerTrips} ` +
    `cooldown_ms=${cfg.cooldownMs} resume_after=${new Date(openUntilMs).toISOString()}`,
  );
  return { opened: true, consecutiveFailures: 0, openUntilMs };
}

/** Auth / quota / symbol-level errors must not feed the breaker. */
export function classifyIndianApiCandleError(
  err: unknown,
): CandleUpstreamErrorCategory {
  if (err instanceof IndianApiCircuitOpenError) return 'circuit_open';
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { statusCode?: number })?.statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : null;

  if (name === 'IndianApiRateLimitError' || /429|rate.?limit/i.test(msg)) {
    return 'rate_limited_429';
  }
  if (name === 'ApiBudgetExceededError' || /budget|quota/i.test(msg)) {
    return 'quota_exhausted';
  }
  if (name === 'IndianApiConfigError' || /auth|401|403/i.test(msg)) {
    return 'authentication_failed';
  }
  if (status === 503 || /HTTP[_\s-]?503|service unavailable/i.test(msg)) {
    return 'transient_upstream_503';
  }
  if (status != null && status >= 500) return 'transient_upstream_503';
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(msg)) {
    return 'network_timeout';
  }
  if (/unsupported.*series/i.test(msg)) return 'unsupported_symbol_series';
  if (/not found|EMPTY_RESPONSE|no valid daily bars/i.test(msg)) {
    return 'symbol_not_found';
  }
  if (/parse|malformed|invalid.?response/i.test(msg)) return 'invalid_response';
  return 'upstream_error';
}

/** Categories that count toward the global historical breaker. */
export function feedsIndianApiHistoricalCircuit(
  category: CandleUpstreamErrorCategory,
): boolean {
  return (
    category === 'transient_upstream_503'
    || category === 'network_timeout'
  );
}
