// ════════════════════════════════════════════════════════════════
//  yahooCircuitBreaker — NEUTRALIZED STUB // @deprecated marker
//  @deprecated — provider-level resilience now lives in
//  src/providers/resilience.ts (used by MarketDataProvider).
//
//  Yahoo Finance integration has been removed; the breaker is no // @deprecated marker
//  longer load-bearing. Public surface preserved so importers
//  compile, but all calls are no-ops:
//    isYahooAvailable() returns true (no breaker to trip) // @deprecated marker
//    record* functions are no-ops
//    getYahooBreakerStats() returns zeroed stats // @deprecated marker
// ════════════════════════════════════════════════════════════════

export function isYahooAvailable(): boolean { // @deprecated marker
  return true;
}

export function recordYahooSuccess(): void { // @deprecated marker
  /* no-op */
}

export function recordYahooFailure(_reason?: string): void { // @deprecated marker
  /* no-op */
}

export function getYahooBreakerStats(): { // @deprecated marker
  state:               'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  totalSuccesses:      number;
  totalFailures:       number;
  trips:               number;
  msUntilReopen:       number;
  lastTripAt:          number;
  lastSuccessAt:       number;
  threshold:           number;
  pauseMs:             number;
} {
  return {
    state:               'closed',
    consecutiveFailures: 0,
    totalSuccesses:      0,
    totalFailures:       0,
    trips:               0,
    msUntilReopen:       0,
    lastTripAt:          0,
    lastSuccessAt:       0,
    threshold:           0,
    pauseMs:             0,
  };
}

export function resetYahooBreaker(): void { // @deprecated marker
  /* no-op */
}
