// ════════════════════════════════════════════════════════════════
//  providerReport — in-process counters for SMART_FALLBACK_SYSTEM
//
//  Tracks every provider hop the resolver makes so /api/debug/provider-report
//  can answer "what did the upstream actually do during the last few
//  resolves?" without grepping log files.
//
//  Process-local. Counters reset on restart — that's intentional.
// ════════════════════════════════════════════════════════════════

export type ReportProvider = 'kite' | 'nse' | 'yahoo' | 'snapshot';

export interface ProviderReport {
  /** Provider that served the most recent resolve. Null until the
   *  first call lands. */
  last_provider:      ReportProvider | null;
  /** Cumulative call counts since process start. */
  kite_calls:         number;
  nse_calls:          number;
  yahoo_calls:        number;
  snapshot_calls:     number;
  /** True when the most recent resolve cascaded past the primary. */
  fallback_triggered: boolean;
  /** Compact reason string from the most recent failure. */
  last_error:         string | null;
  /** ISO timestamp of the last counter update. */
  last_updated_at:    string | null;
}

const state: ProviderReport = {
  last_provider:      null,
  kite_calls:         0,
  nse_calls:          0,
  yahoo_calls:        0,
  snapshot_calls:     0,
  fallback_triggered: false,
  last_error:         null,
  last_updated_at:    null,
};

export interface RecordCallOptions {
  /** True when this provider served the request as a fallback. */
  fallback?: boolean;
  /** Compact failure reason, when applicable. Pass null on success
   *  to clear the previous error marker. */
  error?:   string | null;
}

/**
 * Record a single provider hop.
 */
export function recordProviderCall(
  provider: ReportProvider,
  opts: RecordCallOptions = {},
): void {
  switch (provider) {
    case 'kite':      state.kite_calls      += 1; break;
    case 'nse':       state.nse_calls       += 1; break;
    case 'yahoo':     state.yahoo_calls     += 1; break;
    case 'snapshot':  state.snapshot_calls  += 1; break;
  }
  state.last_provider      = provider;
  state.fallback_triggered = !!opts.fallback;
  if (opts.error !== undefined) state.last_error = opts.error;
  state.last_updated_at    = new Date().toISOString();
}

/**
 * Update `last_error` (and optionally `last_provider`) WITHOUT bumping
 * any counter.
 */
export function updateLastError(
  error: string | null,
  provider?: ReportProvider,
): void {
  state.last_error      = error;
  if (provider) state.last_provider = provider;
  state.last_updated_at = new Date().toISOString();
}

/** Snapshot of the current counters. Returns a defensive copy so
 *  callers can't mutate internal state. */
export function getProviderReport(): ProviderReport {
  return { ...state };
}

/** Test helper — wipe counters between cases. */
export function _resetProviderReportForTests(): void {
  state.last_provider      = null;
  state.kite_calls         = 0;
  state.nse_calls          = 0;
  state.yahoo_calls        = 0;
  state.snapshot_calls     = 0;
  state.fallback_triggered = false;
  state.last_error         = null;
  state.last_updated_at    = null;
}
