// ════════════════════════════════════════════════════════════════
//  Backtest Queue — async execution wrapper around runBacktest.
//
//  Why this exists:
//    POST /api/backtests used to call `await runBacktest(config)` inside
//    the request, which on a slow run could exceed the Next.js / proxy
//    timeout and return an HTML 502/504 page. The frontend then crashed
//    with "Unexpected token '<'". This module replaces that flow with:
//
//      1. queueBacktestRun(config)
//         INSERTs a backtest_runs row with status='queued' and fires
//         processBacktestRun(runId) without awaiting. The HTTP caller
//         returns immediately.
//
//      2. processBacktestRun(runId)
//         Atomic claim (UPDATE ... WHERE status='queued') guards against
//         duplicate execution. On success the row transitions QUEUED →
//         RUNNING → COMPLETED. On error → FAILED with error_message.
//
//      3. processQueuedBacktestRuns(max)
//         Bulk drain — for the manual /api/backtests/process-queue
//         endpoint and any future cron registration.
//
//  Concurrency model:
//    - DB row state is the source of truth across processes.
//    - In-process `inflight` set prevents a second async tick on the
//      same Node instance from claiming the same run twice between
//      the SELECT and the UPDATE.
//    - Atomic UPDATE WHERE status='queued' is the cross-process guard.
//
//  Known limitation:
//    runBacktest does not currently expose a progress callback. We
//    stamp coarse milestones (Starting / Loading market data /
//    Running simulation / Persisting / Completed) instead of faking
//    fine-grained percent completion.
// ════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { ensureBacktestTables } from '../repository/migrate';
import { DEFAULT_BACKTEST_CONFIG } from '../config/defaults';
import { runBacktest } from './backtestRunner';
import { persistFullRun } from './runOrchestrator';
import type { BacktestRunConfig } from '../types';

// DB stores lowercase strings (legacy default 'queued'). The API
// surface normalizes to UPPER per spec.
const DB_STATUS = {
  QUEUED:    'queued',
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
} as const;

export type ApiStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

const inflight = new Set<string>();

/** Map a DB status string to the API vocabulary. */
export function normalizeStatus(raw: string | null | undefined): ApiStatus {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'queued')                                return 'QUEUED';
  if (v === 'running')                               return 'RUNNING';
  if (v === 'failed')                                return 'FAILED';
  if (v === 'cancelled' || v === 'canceled')         return 'CANCELLED';
  // partial_success is treated as COMPLETED on the API surface — the
  // run finished, persistence had some non-fatal issues. The detail
  // route still exposes the underlying status for diagnostics.
  if (v === 'completed' || v === 'success' || v === 'partial_success') return 'COMPLETED';
  // Unknown legacy values → treat as queued so the row doesn't disappear.
  return 'QUEUED';
}

export interface QueueResult {
  runId:   string;
  status:  ApiStatus;
  message: string;
}

/**
 * Insert a QUEUED row and fire async processing. Returns immediately so
 * the HTTP caller never blocks on the actual backtest execution.
 */
export async function queueBacktestRun(config: BacktestRunConfig): Promise<QueueResult> {
  await ensureBacktestTables();
  const merged: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const runId = merged.runId ?? uuidv4();
  merged.runId = runId;

  // INSERT, not UPSERT — a duplicate run_id collision should error out
  // rather than silently overwrite an in-flight or completed run.
  await db.query(
    `INSERT INTO backtest_runs
       (run_id, name, config_json, status, started_at, progress_percent, current_step)
     VALUES (?, ?, ?, 'queued', NOW(), 0, 'Queued')`,
    [runId, merged.name ?? 'Default Backtest', JSON.stringify(merged)],
  );

  // Fire-and-forget. The catch is here purely to keep the unhandled
  // rejection out of the process — the actual error state is already
  // persisted to backtest_runs.error by markFailed inside the worker.
  void processBacktestRun(runId).catch((err) => {
    console.error(`[BacktestQueue] background processing of ${runId} threw:`, err);
  });

  return {
    runId,
    status:  'QUEUED',
    message: 'Backtest queued successfully',
  };
}

/**
 * Execute a single queued run. Safe to invoke from a worker, a cron
 * tick, or directly after queueBacktestRun. Returns the terminal status.
 */
export async function processBacktestRun(runId: string): Promise<{ status: ApiStatus; error?: string }> {
  if (inflight.has(runId)) {
    return { status: 'RUNNING', error: 'already in-process on this Node instance' };
  }

  await ensureBacktestTables();

  // Atomic claim. AffectedRows=1 means this caller won the race; 0 means
  // another tick already moved it out of 'queued' (running/completed/cancelled).
  const claim: any = await db.query(
    `UPDATE backtest_runs
        SET status='running', current_step='Starting', progress_percent=5,
            started_at=NOW(), error=NULL
      WHERE run_id=? AND status='queued'`,
    [runId],
  );
  if ((claim.affectedRows ?? 0) === 0) {
    return { status: 'QUEUED', error: 'run is not in queued state' };
  }
  inflight.add(runId);

  try {
    const cfgRow: any = await db.query(
      `SELECT config_json FROM backtest_runs WHERE run_id=?`,
      [runId],
    );
    const raw = cfgRow.rows?.[0]?.config_json ?? '{}';
    const cfg: BacktestRunConfig = typeof raw === 'string' ? JSON.parse(raw) : raw;
    cfg.runId = runId;

    await setProgress(runId, 10, 'Loading market data');

    // runBacktest is the long pole. It internally walks every trading
    // day, generates signals, simulates trades, etc. The function
    // already swallows internal failures into result.status='failed'
    // rather than throwing — we still wrap in try/catch for true panics.
    const result = await runBacktest(cfg);

    if (result.status === 'failed') {
      await markFailed(runId, result.error ?? 'Run reported failed status');
      return { status: 'FAILED', error: result.error ?? undefined };
    }

    await setProgress(runId, 80, 'Persisting results');

    // persistFullRun saves run + trades + equity + metrics + calib +
    // performance + audit + news. It calls saveBacktestRun which uses
    // ON DUPLICATE KEY UPDATE on the same run_id we just inserted, so
    // the row gets its summary_json / signal_count / trade_count
    // populated. The progress_percent / current_step columns are not
    // touched by saveBacktestRun, so our explicit update below is the
    // final word on the queue-side fields.
    try {
      await persistFullRun(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BacktestQueue] persistFullRun failed for ${runId}:`, err);
      await markFailed(runId, `Persistence failed: ${msg}`);
      return { status: 'FAILED', error: 'persistence failed' };
    }

    await db.query(
      `UPDATE backtest_runs
          SET progress_percent=100, current_step='Completed', error=NULL
        WHERE run_id=?`,
      [runId],
    );
    return { status: 'COMPLETED' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(runId, msg);
    return { status: 'FAILED', error: msg };
  } finally {
    inflight.delete(runId);
  }
}

async function setProgress(runId: string, pct: number, step: string): Promise<void> {
  try {
    await db.query(
      `UPDATE backtest_runs
          SET progress_percent=?, current_step=?
        WHERE run_id=? AND status='running'`,
      [pct, step, runId],
    );
  } catch (err) {
    // Progress writes are best-effort — never abort a run for them.
    console.warn(`[BacktestQueue] setProgress(${runId}, ${pct}) failed:`, err);
  }
}

async function markFailed(runId: string, error: string): Promise<void> {
  try {
    await db.query(
      `UPDATE backtest_runs
          SET status='failed', completed_at=NOW(),
              current_step='Failed', error=?
        WHERE run_id=?`,
      [error.slice(0, 65000), runId],
    );
  } catch (err) {
    console.error(`[BacktestQueue] markFailed(${runId}) DB write failed:`, err);
  }
}

/**
 * Bulk drain — kick processing for up to `maxConcurrent` queued runs.
 * Each run is fired async (void), so this call returns quickly with
 * the IDs that were dispatched plus how many remain in queue.
 *
 * Intended for the /api/backtests/process-queue manual trigger and for
 * a future cron registration. Safe to call repeatedly — atomic claim
 * inside processBacktestRun prevents duplicate execution.
 */
export async function processQueuedBacktestRuns(maxConcurrent = 1): Promise<{
  processed: string[];
  remaining: number;
  running:   number;
}> {
  await ensureBacktestTables();
  const safeMax = Math.max(1, Math.min(8, Math.floor(maxConcurrent)));

  const { rows }: any = await db.query(
    `SELECT run_id FROM backtest_runs
      WHERE status='queued'
      ORDER BY started_at ASC
      LIMIT ?`,
    [safeMax],
  );
  const processed: string[] = [];
  for (const r of rows ?? []) {
    const runId = String((r as any).run_id);
    void processBacktestRun(runId).catch((err) => {
      console.error(`[BacktestQueue] processQueuedBacktestRuns(${runId}) error:`, err);
    });
    processed.push(runId);
  }

  let queued = 0;
  let running = 0;
  try {
    const { rows: counts }: any = await db.query(
      `SELECT status, COUNT(*) AS n FROM backtest_runs
        WHERE status IN ('queued','running')
        GROUP BY status`,
    );
    for (const r of counts ?? []) {
      if ((r as any).status === 'queued')  queued  = Number((r as any).n);
      if ((r as any).status === 'running') running = Number((r as any).n);
    }
  } catch (err) {
    console.warn('[BacktestQueue] queue stats failed:', err);
  }

  // `processed` runs are now in 'running' state, so they're not counted
  // in `queued` anymore — subtract is wrong. Report queued as-is.
  return { processed, remaining: queued, running };
}

/**
 * Cancel a queued run. Running runs cannot be cancelled mid-flight in
 * this implementation — runBacktest has no cooperative abort signal.
 */
export async function cancelBacktestRun(runId: string): Promise<{
  status:  ApiStatus;
  changed: boolean;
  reason?: string;
}> {
  await ensureBacktestTables();
  const result: any = await db.query(
    `UPDATE backtest_runs
        SET status='cancelled', completed_at=NOW(), current_step='Cancelled'
      WHERE run_id=? AND status='queued'`,
    [runId],
  );
  if ((result.affectedRows ?? 0) > 0) return { status: 'CANCELLED', changed: true };

  const { rows }: any = await db.query(
    `SELECT status FROM backtest_runs WHERE run_id=?`,
    [runId],
  );
  if (!rows || rows.length === 0) {
    return { status: 'CANCELLED', changed: false, reason: 'run not found' };
  }
  const current = normalizeStatus((rows[0] as any).status);
  if (current === 'RUNNING') {
    return {
      status:  'RUNNING',
      changed: false,
      reason:  'Cancellation of running backtests is not supported yet.',
    };
  }
  return { status: current, changed: false, reason: `Already in ${current} state.` };
}

// Re-export the DB constants so callers don't have to drift the
// canonical strings.
export { DB_STATUS };
