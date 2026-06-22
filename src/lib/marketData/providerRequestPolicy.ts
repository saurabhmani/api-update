// ════════════════════════════════════════════════════════════════
//  IndianAPI request budget policy — operational guardrails
//
//  Docs: docs/PROVIDER_REQUEST_POLICY.md
// ════════════════════════════════════════════════════════════════

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

/** One-time initial warehouse load: ~1 req/symbol × NSE 1000 universe. */
export const INITIAL_BACKFILL_EXPECTED_MIN = () =>
  envNum('INDIAN_API_INITIAL_BACKFILL_EXPECTED_MIN', 500, 5_000, 1_000);

export const INITIAL_BACKFILL_EXPECTED_MAX = () =>
  envNum('INDIAN_API_INITIAL_BACKFILL_EXPECTED_MAX', 500, 5_000, 1_500);

/** Per-run cap for a full initial backfill (1y daily per symbol). */
export const INITIAL_BACKFILL_PER_RUN_LIMIT = () =>
  envNum(
    'INDIAN_API_INITIAL_BACKFILL_PER_RUN_LIMIT',
    100,
    5_000,
    INITIAL_BACKFILL_EXPECTED_MAX(),
  );

/** Scheduled evening incremental update — max billable requests per run. */
export const DAILY_UPDATE_MAX_REQUESTS = () =>
  envNum('CANDLE_DAILY_UPDATE_MAX_FETCH', 100, 5_000, 1_000);

/** Emergency repair batches — only thin/stale/missing symbols (`resume: true`). */
export const EMERGENCY_REPAIR_MAX_FETCH = () =>
  envNum('CANDLE_REPAIR_MAX_FETCH', 1, 500, 50);

/** Planned monthly burn (ops target); hard ceiling stays INDIANAPI_MONTHLY_LIMIT. */
export const MONTHLY_PLANNING_MIN = () =>
  envNum('INDIAN_API_MONTHLY_PLANNING_MIN', 5_000, 200_000, 22_000);

export const MONTHLY_PLANNING_MAX = () =>
  envNum('INDIAN_API_MONTHLY_PLANNING_MAX', 5_000, 200_000, 30_000);

export const MONTHLY_PLANNING_TARGET = () =>
  envNum(
    'INDIANAPI_MONTHLY_TARGET',
    MONTHLY_PLANNING_MIN(),
    MONTHLY_PLANNING_MAX() * 2,
    25_000,
  );

export interface ProviderRequestPolicySnapshot {
  initial_backfill: {
    run_once: true;
    expected_requests_min: number;
    expected_requests_max: number;
    per_run_limit: number;
    history_range: '1y';
  };
  daily: {
    morning_scan_max_requests: 0;
    evening_update_max_requests: number;
    evening_scan_max_requests: 0;
  };
  monthly: {
    planning_min: number;
    planning_max: number;
    planning_target: number;
  };
  emergency_repair: {
    resume_only: true;
    default_batch_size: number;
  };
  avoid: string[];
}

export function getProviderRequestPolicy(): ProviderRequestPolicySnapshot {
  return {
    initial_backfill: {
      run_once: true,
      expected_requests_min: INITIAL_BACKFILL_EXPECTED_MIN(),
      expected_requests_max: INITIAL_BACKFILL_EXPECTED_MAX(),
      per_run_limit: INITIAL_BACKFILL_PER_RUN_LIMIT(),
      history_range: '1y',
    },
    daily: {
      morning_scan_max_requests: 0,
      evening_update_max_requests: DAILY_UPDATE_MAX_REQUESTS(),
      evening_scan_max_requests: 0,
    },
    monthly: {
      planning_min: MONTHLY_PLANNING_MIN(),
      planning_max: MONTHLY_PLANNING_MAX(),
      planning_target: MONTHLY_PLANNING_TARGET(),
    },
    emergency_repair: {
      resume_only: true,
      default_batch_size: EMERGENCY_REPAIR_MAX_FETCH(),
    },
    avoid: [
      'Full 1-year backfill twice daily',
      'Fetching candles inside strategy evaluation',
      'Fetching historical data during every signal scan',
      'Retrying failed provider requests too aggressively',
      'Using IndianAPI when DB already has fresh candle data',
    ],
  };
}

/** Resolve per-run IndianAPI cap for candle backfill jobs. */
export function resolveBackfillPerRunLimit(opts: {
  resume?: boolean;
  maxFetch?: number;
  symbols?: string[];
}): number {
  if (opts.maxFetch != null && opts.maxFetch > 0) return opts.maxFetch;
  if (opts.symbols?.length) return Math.max(opts.symbols.length, EMERGENCY_REPAIR_MAX_FETCH());
  if (opts.resume) return EMERGENCY_REPAIR_MAX_FETCH();
  return INITIAL_BACKFILL_PER_RUN_LIMIT();
}

/** Resolve max symbols to fetch in a backfill job. */
export function resolveBackfillMaxFetch(opts: {
  resume?: boolean;
  maxFetch?: number;
  symbols?: string[];
}): number | undefined {
  if (opts.maxFetch != null && opts.maxFetch > 0) return opts.maxFetch;
  if (opts.symbols?.length) return opts.symbols.length;
  if (opts.resume) return EMERGENCY_REPAIR_MAX_FETCH();
  return INITIAL_BACKFILL_PER_RUN_LIMIT();
}

/** Resolve evening incremental update fetch cap. */
export function resolveDailyUpdateMaxFetch(maxFetch?: number): number {
  if (maxFetch != null && maxFetch > 0) return maxFetch;
  return DAILY_UPDATE_MAX_REQUESTS();
}
