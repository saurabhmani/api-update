// ════════════════════════════════════════════════════════════════
//  Pipeline Run Lock — Step 6 of the IndianAPI cutover.
//
//  Manual /api/run-signal-engine is allowed once per IST calendar
//  day. Scheduled / system runs (cron, in-proc scheduler) use
//  separate run_type values and are not affected.
//
//  Lifecycle of a row:
//    1. tryClaimManualRun() inserts (run_type='manual', run_date=today,
//       status='started'). The unique key enforces single-claim.
//    2. The route runs the pipeline.
//    3. On completion, completeManualRun() flips status='completed'.
//       On failure, failManualRun() flips status='failed'.
//
//  If a run "started" but never finished (process crashed, network
//  blip), the row stays. Day rolls over → next day's claim succeeds.
//  Same-day, the second claim returns the existing row's timestamps.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

export type RunType   = 'manual' | 'scheduled' | 'system';
export type RunStatus = 'started' | 'completed' | 'failed' | 'blocked';

const EXECUTION_LOCK_DATE = '2000-01-01';

export interface RunLockRow {
  id:               number;
  run_type:         RunType;
  run_date:         string;          // YYYY-MM-DD
  timezone:         string;
  requested_by:     string | null;
  request_source:   string | null;
  status:           RunStatus;
  started_at:       string;          // ISO
  completed_at:     string | null;
  error_message:    string | null;
  force_override:   boolean;
  override_reason:  string | null;
}

const IST_TZ = 'Asia/Kolkata';

/** Today's IST calendar date as 'YYYY-MM-DD'. */
export function istCalendarDate(d = new Date()): string {
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Next IST midnight as an ISO string. Used to surface "next available". */
export function nextIstMidnightIso(d = new Date()): string {
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(ms);
  ist.setUTCHours(24, 0, 0, 0);          // tomorrow IST 00:00
  // Convert back to UTC for the response timestamp.
  const utcMs = ist.getTime() - 5.5 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function asLockRow(row: any): RunLockRow {
  return {
    id:              Number(row.id),
    run_type:        row.run_type,
    run_date:        typeof row.run_date === 'string'
                       ? row.run_date.slice(0, 10)
                       : new Date(row.run_date).toISOString().slice(0, 10),
    timezone:        row.timezone,
    requested_by:    row.requested_by ?? null,
    request_source:  row.request_source ?? null,
    status:          row.status,
    started_at:      row.started_at instanceof Date
                       ? row.started_at.toISOString()
                       : new Date(row.started_at).toISOString(),
    completed_at:    row.completed_at
                       ? (row.completed_at instanceof Date
                           ? row.completed_at.toISOString()
                           : new Date(row.completed_at).toISOString())
                       : null,
    error_message:   row.error_message ?? null,
    force_override:  !!Number(row.force_override ?? 0),
    override_reason: row.override_reason ?? null,
  };
}

/** Read the existing row for a run_type / run_date pair, if any. */
export async function getLockRow(
  runType: RunType,
  runDate: string = istCalendarDate(),
): Promise<RunLockRow | null> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_pipeline_run_locks
       WHERE run_type = ? AND run_date = ?
       LIMIT 1`,
    [runType, runDate],
  );
  if (!rows || rows.length === 0) return null;
  return asLockRow(rows[0]);
}

export interface ClaimRequest {
  requestedBy?:    string | null;
  requestSource?:  string | null;
  /** When true, ignore an existing same-day row and force a new
   *  claim. Intended ONLY for admin re-runs (env PIPELINE_MANUAL_OVERRIDE
   *  or an admin-only endpoint). The override is recorded in the row's
   *  `force_override` column with `override_reason` so audits can see
   *  when it fired and why. */
  override?:       boolean;
  /** Free-form audit reason; required when `override=true`. */
  overrideReason?: string | null;
}

/** Read PIPELINE_MANUAL_OVERRIDE — `true` allows admins to bypass
 *  the once-per-IST-day lock. Defaults to false. */
export function isManualOverrideEnabled(): boolean {
  const v = (process.env.PIPELINE_MANUAL_OVERRIDE ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export interface ClaimResult {
  /** True only when the caller now owns the run. */
  claimed:       boolean;
  row:           RunLockRow;
  /** Convenience: ISO of the most recent run on this run_type. */
  lastRunAt:     string | null;
  /** Convenience: ISO when the next manual run will be allowed
   *  (next IST midnight). Always present so the UI can render a clock. */
  nextAllowedAt: string;
  message:       string;
}

/**
 * Insert (or attempt to insert) the day's manual lock row. Race-safe
 * via the (run_type, run_date) UNIQUE key — two parallel callers will
 * see exactly one win and one fail-with-existing-row.
 */
export async function tryClaimManualRun(
  req: ClaimRequest = {},
): Promise<ClaimResult> {
  const runDate = istCalendarDate();
  const requestedBy    = req.requestedBy   ?? null;
  const requestSource  = req.requestSource ?? 'frontend';
  const override       = !!req.override;
  const overrideReason = req.overrideReason ?? null;

  // Block-or-not policy:
  //   • Existing row with status='started' or 'completed' → BLOCK.
  //     Caller may re-run only with an explicit admin override AND a
  //     non-empty override reason.
  //   • Existing row with status='failed' → does NOT consume the
  //     daily allowance (per spec). The row is replaced with a fresh
  //     'started' row so the new attempt has clean timestamps.
  //   • No existing row → claim normally.
  const existing = await getLockRow('manual', runDate);
  if (existing && (existing.status === 'started' || existing.status === 'completed')) {
    if (!override) {
      return {
        claimed: false,
        row: existing,
        lastRunAt: existing.completed_at ?? existing.started_at,
        nextAllowedAt: nextIstMidnightIso(),
        message: `Manual run already used today. Next available at 12:00 AM IST.`,
      };
    }
    // Override path requires a reason — refuse the override otherwise.
    if (!overrideReason || overrideReason.trim() === '') {
      return {
        claimed: false,
        row: existing,
        lastRunAt: existing.completed_at ?? existing.started_at,
        nextAllowedAt: nextIstMidnightIso(),
        message: 'Admin override requires a non-empty override_reason.',
      };
    }
    await db.query(
      `DELETE FROM q365_pipeline_run_locks
        WHERE run_type='manual' AND run_date=?`,
      [runDate],
    );
  } else if (existing && existing.status === 'failed') {
    // Failed runs do not consume the daily allowance. Drop the row
    // so the new attempt starts clean. (No override required.)
    await db.query(
      `DELETE FROM q365_pipeline_run_locks
        WHERE run_type='manual' AND run_date=?`,
      [runDate],
    );
  }

  // Insert the fresh claim row. The unique key (run_type, run_date)
  // makes this race-safe: parallel callers see exactly one INSERT
  // succeed and the loser's INSERT collapses to a no-op via ON DUPLICATE.
  await db.query(
    `INSERT INTO q365_pipeline_run_locks
       (run_type, run_date, timezone, requested_by, request_source,
        status, started_at, force_override, override_reason)
     VALUES (?, ?, ?, ?, ?, 'started', NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    ['manual', runDate, IST_TZ, requestedBy, requestSource,
     override ? 1 : 0, override ? overrideReason : null],
  );

  const row = await getLockRow('manual', runDate);
  if (!row) {
    throw new Error('runLockRepo: row missing after upsert');
  }

  // Ownership proxy: the row reflects this caller's metadata AND was
  // started within the last few seconds AND status='started'.
  const claimed =
    row.requested_by === requestedBy &&
    row.request_source === requestSource &&
    row.status === 'started' &&
    Math.abs(Date.now() - new Date(row.started_at).getTime()) < 5_000;

  const lastRunAt = row.completed_at ?? row.started_at;
  const nextAllowedAt = nextIstMidnightIso();

  return {
    claimed,
    row,
    lastRunAt,
    nextAllowedAt,
    message: claimed
      ? (override
          ? `Manual pipeline run claimed via admin override (reason: ${overrideReason}).`
          : 'Manual pipeline run claimed for today.')
      : `Manual run already used today. Next available at 12:00 AM IST.`,
  };
}

export async function completeManualRun(): Promise<void> {
  await db.query(
    `UPDATE q365_pipeline_run_locks
        SET status='completed', completed_at = NOW()
      WHERE run_type='manual' AND run_date = ?`,
    [istCalendarDate()],
  );
}

export async function failManualRun(error: string): Promise<void> {
  await db.query(
    `UPDATE q365_pipeline_run_locks
        SET status='failed', completed_at = NOW(),
            error_message = ?
      WHERE run_type='manual' AND run_date = ?`,
    [error.slice(0, 1000), istCalendarDate()],
  );
}

// ── Distributed Execution Lock ──────────────────────────────────
export async function tryAcquireExecutionLock(batchId: string): Promise<boolean> {
  const existing = await getLockRow('system', EXECUTION_LOCK_DATE);
  if (existing && existing.status === 'started') return false;

  if (existing) {
    await db.query(
      `DELETE FROM q365_pipeline_run_locks WHERE run_type='system' AND run_date=?`,
      [EXECUTION_LOCK_DATE]
    );
  }

  await db.query(
    `INSERT INTO q365_pipeline_run_locks
       (run_type, run_date, timezone, request_source, status, started_at)
     VALUES ('system', ?, ?, ?, 'started', NOW())
     ON DUPLICATE KEY UPDATE id = id`,
    [EXECUTION_LOCK_DATE, IST_TZ, batchId]
  );

  const row = await getLockRow('system', EXECUTION_LOCK_DATE);
  return row?.request_source === batchId && row?.status === 'started';
}

export async function releaseExecutionLock(): Promise<void> {
  await db.query(
    `UPDATE q365_pipeline_run_locks SET status='completed', completed_at=NOW()
     WHERE run_type='system' AND run_date=? AND status='started'`,
    [EXECUTION_LOCK_DATE]
  );
}

export async function heartbeatExecutionLock(): Promise<void> {
  await db.query(
    `UPDATE q365_pipeline_run_locks SET started_at = NOW()
     WHERE run_type='system' AND run_date = ? AND status='started'`,
    [EXECUTION_LOCK_DATE]
  );
}

export async function recoverStaleExecutionLock(): Promise<void> {
  const minutes = resolveStaleMinutes();
  await db.query(
    `UPDATE q365_pipeline_run_locks
        SET status='failed', completed_at = NOW(),
            error_message = CONCAT('stale-execution-recovery age > ', ?, 'min')
      WHERE run_type='system' AND run_date = ?
        AND status='started' AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [minutes, EXECUTION_LOCK_DATE, minutes]
  );
}

// ── Stale lock recovery + heartbeat ─────────────────────────────
// LOCK-STALE-FIX (2026-05) — a row left in status='started' by a
// crashed process used to block every subsequent claim until the
// next IST midnight. recoverStaleManualRun() flips such rows to
// 'failed' if their started_at is older than `maxAgeMinutes`, so the
// next claim path's "failed → fresh row" handling can reclaim the
// allowance. heartbeatManualRun() bumps started_at on long-running
// runs so the watchdog doesn't mistake an in-progress run for a
// crashed one.
const STALE_LOCK_DEFAULT_MIN = 30;

function resolveStaleMinutes(): number {
  const raw = Number(process.env.PIPELINE_LOCK_STALE_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return STALE_LOCK_DEFAULT_MIN;
  return Math.max(5, Math.min(360, Math.floor(raw)));
}

export async function recoverStaleManualRun(): Promise<RunLockRow | null> {
  const minutes = resolveStaleMinutes();
  const row = await getLockRow('manual');
  if (!row) return null;
  if (row.status !== 'started') return null;
  const startedMs = new Date(row.started_at).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const ageMin = (Date.now() - startedMs) / 60_000;
  if (ageMin < minutes) return null;
  await db.query(
    `UPDATE q365_pipeline_run_locks
        SET status='failed', completed_at = NOW(),
            error_message = CONCAT('stale-recovery age=', ?, 'min')
      WHERE run_type='manual' AND run_date = ?
        AND status='started'`,
    [Math.round(ageMin), istCalendarDate()],
  );
  console.warn(
    `[ENGINE_LOCK_STALE_RECOVERED] age_min=${Math.round(ageMin)} ` +
    `threshold_min=${minutes} run_date=${row.run_date}`,
  );
  return getLockRow('manual');
}

export async function heartbeatManualRun(): Promise<void> {
  // Bump started_at to "now" while keeping status='started'. The
  // watchdog uses started_at as the age signal; a live heartbeat
  // resets the timer without flipping the lifecycle state.
  await db.query(
    `UPDATE q365_pipeline_run_locks
        SET started_at = NOW()
      WHERE run_type='manual' AND run_date = ? AND status='started'`,
    [istCalendarDate()],
  );
}

/**
 * For frontend GET endpoints: return today's manual-lock state without
 * mutating anything. Used by /api/run-signal-engine?status to drive the
 * "Run Pipeline" button's enabled / disabled state.
 */
export async function getManualRunStatus(): Promise<{
  used:          boolean;
  inProgress:    boolean;
  row:           RunLockRow | null;
  lastRunAt:     string | null;
  nextAllowedAt: string;
}> {
  const row = await getLockRow('manual');
  return {
    used:          !!row,
    inProgress:    row?.status === 'started',
    row,
    lastRunAt:     row?.completed_at ?? row?.started_at ?? null,
    nextAllowedAt: nextIstMidnightIso(),
  };
}
