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

function asFeedHealthRow(row: Record<string, unknown> | null | undefined): FeedHealthRow | null {
  if (!row) return null;
  const toIso = (v: unknown): string => {
    if (v instanceof Date) return v.toISOString();
    const s = String(v ?? '');
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
    return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  };
  return {
    provider: String(row.provider ?? ''),
    endpoint: String(row.endpoint ?? ''),
    request_started_at: toIso(row.request_started_at),
    response_received_at: toIso(row.response_received_at),
    status: String(row.status ?? 'failed'),
    latency_ms: Number(row.latency_ms ?? 0),
    symbols_requested: Number(row.symbols_requested ?? 0),
    symbols_returned: Number(row.symbols_returned ?? 0),
    coverage_percent: Number(row.coverage_percent ?? 0),
    data_quality: String(row.data_quality ?? 'LOW'),
    error_code: row.error_code != null ? String(row.error_code) : null,
    error_message: row.error_message != null ? String(row.error_message) : null,
  };
}

/**
 * Process-local ring is empty after every restart. Persist rows in
 * q365_data_feed_health so the signals status bar still shows Last
 * API Request / Last Success across boots and multi-process deploys.
 * Prefer real upstream providers over cache/snapshot noise.
 */
export async function getLastRequestRowPersistent(): Promise<FeedHealthRow | null> {
  const mem = getLastRequestRow();
  if (mem) return mem;
  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT provider, endpoint, request_started_at, response_received_at,
              status, latency_ms, symbols_requested, symbols_returned,
              coverage_percent, data_quality, error_code, error_message
         FROM q365_data_feed_health
        WHERE LOWER(provider) NOT IN ('cache', 'snapshot', 'db snapshot')
        ORDER BY request_started_at DESC
        LIMIT 1`,
    );
    const upstream = asFeedHealthRow(rows?.[0]);
    if (upstream) return upstream;
    const { rows: anyRows } = await db.query<Record<string, unknown>>(
      `SELECT provider, endpoint, request_started_at, response_received_at,
              status, latency_ms, symbols_requested, symbols_returned,
              coverage_percent, data_quality, error_code, error_message
         FROM q365_data_feed_health
        ORDER BY request_started_at DESC
        LIMIT 1`,
    );
    return asFeedHealthRow(anyRows?.[0]);
  } catch {
    return null;
  }
}

export async function getLastSuccessRowPersistent(): Promise<FeedHealthRow | null> {
  const mem = getLastSuccessRow();
  if (mem) return mem;
  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT provider, endpoint, request_started_at, response_received_at,
              status, latency_ms, symbols_requested, symbols_returned,
              coverage_percent, data_quality, error_code, error_message
         FROM q365_data_feed_health
        WHERE status IN ('success', 'partial')
          AND LOWER(provider) NOT IN ('cache', 'snapshot', 'db snapshot')
        ORDER BY response_received_at DESC
        LIMIT 1`,
    );
    const upstream = asFeedHealthRow(rows?.[0]);
    if (upstream) return upstream;
    const { rows: anyRows } = await db.query<Record<string, unknown>>(
      `SELECT provider, endpoint, request_started_at, response_received_at,
              status, latency_ms, symbols_requested, symbols_returned,
              coverage_percent, data_quality, error_code, error_message
         FROM q365_data_feed_health
        WHERE status IN ('success', 'partial')
        ORDER BY response_received_at DESC
        LIMIT 1`,
    );
    return asFeedHealthRow(anyRows?.[0]);
  } catch {
    return null;
  }
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
