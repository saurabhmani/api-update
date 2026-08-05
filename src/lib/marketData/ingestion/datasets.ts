// ════════════════════════════════════════════════════════════════
//  IndianAPI dataset classification — refresh cadence, cache TTL and
//  ingestion priority per data category.
//
//  Static / slow-changing data must NEVER refresh on the price
//  schedule; the split below is the contract the scheduler wiring
//  and the orchestrator honor.
// ════════════════════════════════════════════════════════════════

export type IndianApiDataset =
  | 'quotes'        // delayed live prices           P0
  | 'movers'        // trending / most-active        P0
  | 'eod'           // end-of-day candles            P1
  | 'historical'    // backfill / repair             P2
  | 'profile'       // company profile / sector      P2
  | 'fundamentals'  // statements / ratios           P3
  | 'corporate'     // corporate actions             P3
  | 'metadata';     // symbol metadata               P3

export interface DatasetPolicy {
  /** Ingestion priority: 0 highest. */
  priority: 0 | 1 | 2 | 3;
  /** Human-readable schedule (actual cron wiring lives in scheduler). */
  cadence: string;
  /** Redis cache TTL in seconds for rows produced by this dataset. */
  cacheTtlS: number;
  /** Age (ms) past which a row counts as stale for monitoring. */
  staleAfterMs: number;
}

export const DATASET_POLICIES: Record<IndianApiDataset, DatasetPolicy> = {
  quotes: {
    priority: 0,
    cadence: 'every 10 min during market hours (batch tier)',
    cacheTtlS: 60,
    staleAfterMs: 15 * 60_000,
  },
  movers: {
    priority: 0,
    cadence: 'every 10-15 min during market hours',
    cacheTtlS: 9 * 60,
    staleAfterMs: 30 * 60_000,
  },
  eod: {
    priority: 1,
    cadence: 'daily post-close (16:00 IST candle update)',
    cacheTtlS: 24 * 60 * 60,
    staleAfterMs: 2 * 24 * 60 * 60_000,
  },
  historical: {
    priority: 2,
    cadence: 'one-shot bootstrap + repair only (never cron full backfill)',
    cacheTtlS: 24 * 60 * 60,
    staleAfterMs: 7 * 24 * 60 * 60_000,
  },
  profile: {
    priority: 2,
    cadence: 'weekly rotation (off-peak)',
    cacheTtlS: 6 * 60 * 60,
    staleAfterMs: 14 * 24 * 60 * 60_000,
  },
  fundamentals: {
    priority: 3,
    cadence: 'weekly-monthly rotation (off-peak)',
    cacheTtlS: 12 * 60 * 60,
    staleAfterMs: 35 * 24 * 60 * 60_000,
  },
  corporate: {
    priority: 3,
    cadence: 'daily off-peak (when plan endpoint verified)',
    cacheTtlS: 24 * 60 * 60,
    staleAfterMs: 3 * 24 * 60 * 60_000,
  },
  metadata: {
    priority: 3,
    cadence: 'weekly with universe rebuild',
    cacheTtlS: 7 * 24 * 60 * 60,
    staleAfterMs: 14 * 24 * 60 * 60_000,
  },
};

export function getDatasetPolicy(dataset: IndianApiDataset): DatasetPolicy {
  return DATASET_POLICIES[dataset];
}
