// ════════════════════════════════════════════════════════════════
//  cleanupPolicy — predicate used by /api/admin/cleanup-confirmed
//
//  Extracted from src/app/api/admin/cleanup-confirmed/route.ts so
//  the SQL fragment + reason string have a single home and can be
//  unit-tested independently of the route handler.
//
//  The predicate matches an ACTIVE confirmed-signal row that fails
//  the current institutional thresholds. Any one condition triggers
//  the row to be flipped to status='INVALIDATED'. Rows are NEVER
//  deleted.
// ════════════════════════════════════════════════════════════════

/** invalidation_reason set on every row touched by the cleanup. */
export const CLEANUP_INVALIDATION_REASON =
  'failed_current_confirmation_thresholds';

/**
 * SQL `WHERE` fragment (without the leading WHERE).
 *
 * Use as:
 *   `UPDATE q365_confirmed_signal_snapshots SET ... WHERE ${CLEANUP_PREDICATE_SQL}`
 *
 * Or to count the would-affect set:
 *   `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots WHERE ${CLEANUP_PREDICATE_SQL}`
 */
export const CLEANUP_PREDICATE_SQL = `
     status = 'ACTIVE'
 AND (
        COALESCE(maturity_score, 0)             < 88
     OR COALESCE(validation_cycles_passed, 0)   < 3
     OR COALESCE(confidence_score, 0)           < 80
     OR COALESCE(final_score, 0)                < 75
     OR COALESCE(rr_ratio, 0)                   < 2.2
     OR COALESCE(expected_edge_percent, 0)      <= 2
     OR UPPER(COALESCE(classification, '')) IN (
          'DEVELOPING_SETUP', 'WATCHLIST_ONLY', 'NO_TRADE',
          'DEVELOPING', 'WATCHLIST'
        )
     )
`.trim();
