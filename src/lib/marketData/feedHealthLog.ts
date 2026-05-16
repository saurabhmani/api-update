// ════════════════════════════════════════════════════════════════
//  feedHealthLog — best-effort writer for q365_data_feed_health.
//
//  Every market-data invocation writes one row here so the
//  /api/data-feed/health endpoint and the dashboard's freshness
//  panel can show "last request / last success / coverage / freshness"
//  with exact IST timestamps.
//
//  Failure-mode contract:
//    • This logger NEVER throws. A logging hiccup must not break
//      the provider's actual operation.
//    • The DB insert is best-effort. If the table doesn't exist
//      yet (first deploy, fresh DB), the writer silently no-ops
//      after the first insert error per process.
//    • There is also an in-memory ring buffer of the last N rows so
//      the frontend can render a live feed even if the DB write
//      lags or fails.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'feedHealthLog' });

/** Spec-aligned status enum (matches q365_data_feed_health DDL).
 *  Internally we accept a wider set so transitional callers don't
 *  break; `normalizeStatus` collapses anything else onto this set. */
export type FeedHealthStatus =
  | 'success'
  | 'failed'
  | 'rate_limited'
  | 'timeout'
  | 'fallback_used';

export type FeedHealthQuality = 'HIGH' | 'MEDIUM' | 'LOW';

/** Map any incoming status (including the resolver's wider set:
 *  'partial' / 'degraded' / 'circuit_open' / etc.) onto the documented
 *  enum the dashboard renders. */
export function normalizeFeedHealthStatus(raw: string): FeedHealthStatus {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'success' || v === 'partial')     return 'success';
  if (v === 'rate_limited' || v.includes('429') || v === 'rate-limited') return 'rate_limited';
  if (v === 'timeout')                         return 'timeout';
  if (v === 'fallback_used' || v === 'fallback') return 'fallback_used';
  // Everything else (failed / degraded / circuit_open / blocked / ...)
  // collapses to 'failed' — the spec's catch-all bucket for "didn't
  // serve data".
  return 'failed';
}

export interface FeedHealthRow {
  provider:             string;
  endpoint:             string;
  request_started_at:   string;          // ISO string
  response_received_at: string;          // ISO string
  status:               FeedHealthStatus | string;
  latency_ms:           number;
  symbols_requested:    number;
  symbols_returned:     number;
  coverage_percent:     number;
  data_quality:         FeedHealthQuality | string;
  error_code:           string | null;
  error_message:        string | null;
}

// ── In-memory ring buffer ──────────────────────────────────────────

const RING_SIZE = 250;
const ring: FeedHealthRow[] = [];

function pushRing(row: FeedHealthRow): void {
  ring.push(row);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/** Return the in-memory tail (most recent first). Used by the
 *  /api/data-feed/health endpoint. Order: newest at index 0. */
export function getFeedHealthRing(limit = 50): FeedHealthRow[] {
  const n = Math.max(1, Math.min(limit, RING_SIZE));
  const out = ring.slice(-n).reverse();
  return out;
}

/** Snapshot helpers — quick reads for the frontend status panel. */
export function getLastRequestRow(): FeedHealthRow | null {
  return ring.length > 0 ? ring[ring.length - 1] : null;
}
export function getLastSuccessRow(): FeedHealthRow | null {
  for (let i = ring.length - 1; i >= 0; i--) {
    const r = ring[i];
    if (r.status === 'success' || r.status === 'partial') return r;
  }
  return null;
}

// ── DB insert (best-effort) ────────────────────────────────────────

let dbInsertSilenced = false;

/**
 * MySQL `DATETIME(3)` rejects ISO 8601 strings ('2026-05-01T07:20:40.436Z')
 * with `Incorrect datetime value`. Callers across the codebase pass
 * ISO timestamps (from `new Date().toISOString()`); convert here so
 * the public FeedHealthRow API stays portable while the SQL bind is
 * MySQL-compatible. Format: 'YYYY-MM-DD HH:MM:SS.fff'.
 */
function toMysqlDatetime(value: string): string {
  // 'YYYY-MM-DDTHH:MM:SS.fffZ' → 'YYYY-MM-DD HH:MM:SS.fff'
  return value.replace('T', ' ').replace(/Z$/, '');
}

async function insertRow(row: FeedHealthRow): Promise<void> {
  if (dbInsertSilenced) return;
  try {
    await db.query(
      `INSERT INTO q365_data_feed_health
         (provider, endpoint, request_started_at, response_received_at,
          status, latency_ms, symbols_requested, symbols_returned,
          coverage_percent, data_quality, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.provider,
        row.endpoint,
        toMysqlDatetime(row.request_started_at),
        toMysqlDatetime(row.response_received_at),
        row.status,
        row.latency_ms,
        row.symbols_requested,
        row.symbols_returned,
        row.coverage_percent,
        row.data_quality,
        row.error_code,
        row.error_message,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Table may not exist yet (pre-Step 7 deployments). Silence
    // after the first error and rely on the ring buffer.
    if (/no such table|doesn't exist|relation .* does not exist/i.test(msg)) {
      dbInsertSilenced = true;
      log.warn('feedHealthLog: q365_data_feed_health missing — switching to ring-only', { msg });
      return;
    }
    log.warn('feedHealthLog insert failed (non-fatal)', { msg });
  }
}

/**
 * Public entrypoint. Always pushes to the in-memory ring; attempts
 * a DB insert when the table is available. Never awaited by callers
 * (they fire-and-forget) and never throws.
 *
 * The status field is normalized to the documented enum
 * ('success' | 'failed' | 'rate_limited' | 'timeout' | 'fallback_used')
 * before persisting; in-memory ring keeps the original for debugging.
 */
export function logFeedHealth(row: FeedHealthRow): Promise<void> {
  pushRing(row);
  const persistRow: FeedHealthRow = {
    ...row,
    status: normalizeFeedHealthStatus(String(row.status)),
  };
  return insertRow(persistRow).catch(() => { /* swallow */ });
}
