// ════════════════════════════════════════════════════════════════
//  resolveSignalOutcomesJob — daily scheduled outcome resolution
//
//  Schedule: 16:30 IST, Mon–Fri (registered by dailyScanSchedule.ts)
//
//  Acceptance:
//    • Executes automatically via worker scheduler
//    • Runs once per IST calendar day (duplicate guard)
//    • Logs every execution to cron_job_logs
//    • Clears stream-signals cache on success
//    • Hard timeout — completes or aborts within 10 minutes
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { logCronJob } from '@/lib/admin/repository/adminMonitoringRepository';
import { invalidateStreamSignalsCache } from '@/lib/signals/streamSignalsCache';
import {
  resolveSignalOutcomes,
  refreshActiveSignalOutcomes,
  type ResolveSignalOutcomesResult,
} from './resolveSignalOutcomes';

const log = logger.child({ component: 'resolveSignalOutcomesJob' });

export const RESOLVE_SIGNAL_OUTCOMES_JOB_NAME = 'resolveSignalOutcomesJob';
export const RESOLVE_SIGNAL_OUTCOMES_JOB_CRON = '30 16 * * 1-5';
/** Hard ceiling — job must finish within 10 minutes. */
export const RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface ResolveSignalOutcomesJobResult {
  processed: number;
  resolved: number;
  active: number;
  expired: number;
  failed: number;
  executionTimeMs: number;
  skipped: boolean;
  ok: boolean;
  timedOut?: boolean;
  step1?: ResolveSignalOutcomesResult;
  step2?: ResolveSignalOutcomesResult;
  error?: string;
}

let jobInFlight: Promise<ResolveSignalOutcomesJobResult> | null = null;

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export function jobTimeoutMs(): number {
  return envNum(
    'SIGNAL_OUTCOMES_JOB_TIMEOUT_MS',
    60_000,
    RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS,
    RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS,
  );
}

function mergeStepResults(
  step1: ResolveSignalOutcomesResult,
  step2: ResolveSignalOutcomesResult,
): Pick<ResolveSignalOutcomesJobResult, 'processed' | 'resolved' | 'active' | 'expired' | 'failed'> {
  const resolved = step1.targetHits + step1.stopLosses + step1.expired
    + step2.targetHits + step2.stopLosses + step2.expired;

  return {
    processed: step1.processed + step2.processed,
    resolved,
    active: step1.active + step2.active,
    expired: step1.expired + step2.expired,
    failed: step1.errors + step2.errors,
  };
}

function emptyStepResult(errors = 0): ResolveSignalOutcomesResult {
  return {
    processed: 0,
    inserted: 0,
    updated: 0,
    skippedTerminal: 0,
    skippedNoPlan: 0,
    skippedNoCandles: 0,
    errors,
    targetHits: 0,
    stopLosses: 0,
    active: 0,
    expired: 0,
    elapsedMs: 0,
  };
}

function formatError(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack ?? err.message };
  }
  const message = String(err);
  return { message, stack: message };
}

export async function hasSuccessfulRunToday(
  jobName: string = RESOLVE_SIGNAL_OUTCOMES_JOB_NAME,
): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id
       FROM cron_job_logs
      WHERE job_name = ?
        AND status = 'success'
        AND DATE(started_at) = CURDATE()
      LIMIT 1`,
    [jobName],
  );
  return rows.length > 0;
}

export function clearOutcomeResolutionCaches(): void {
  try {
    invalidateStreamSignalsCache();
    log.info('outcome resolution caches cleared');
  } catch (err) {
    log.warn('stream signals cache invalidation failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function logJobRun(input: {
  startedAt: Date;
  finishedAt: Date;
  status: 'success' | 'failed' | 'skipped';
  processedCount: number;
  summary?: Partial<ResolveSignalOutcomesJobResult>;
  errorMessage?: string;
}): Promise<void> {
  const durationMs = input.finishedAt.getTime() - input.startedAt.getTime();
  try {
    await logCronJob({
      jobName: RESOLVE_SIGNAL_OUTCOMES_JOB_NAME,
      jobLabel: 'Signal Outcome Resolution',
      status: input.status,
      durationMs,
      errorMessage: input.errorMessage,
      metadata: {
        processed_count: input.processedCount,
        timeout_ms: jobTimeoutMs(),
        ...input.summary,
      },
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
    });
  } catch (err) {
    log.error('cron_job_logs insert failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`resolveSignalOutcomesJob exceeded ${timeoutMs}ms timeout`);
    this.name = 'JobTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JobTimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function runJobSteps(limit: number): Promise<{
  step1?: ResolveSignalOutcomesResult;
  step2?: ResolveSignalOutcomesResult;
  fatalError?: string;
  fatalStack?: string;
}> {
  let step1: ResolveSignalOutcomesResult | undefined;
  let step2: ResolveSignalOutcomesResult | undefined;
  let fatalError: string | undefined;
  let fatalStack: string | undefined;

  try {
    step1 = await resolveSignalOutcomes({ limit });
  } catch (err) {
    const { message, stack } = formatError(err);
    fatalError = message;
    fatalStack = stack;
    log.error('resolveSignalOutcomesJob step 1 failed', { err: message, stack });
  }

  try {
    step2 = await refreshActiveSignalOutcomes({ limit });
  } catch (err) {
    const { message, stack } = formatError(err);
    if (!fatalError) fatalError = message;
    fatalStack = stack;
    log.error('resolveSignalOutcomesJob step 2 failed', { err: message, stack });
  }

  return { step1, step2, fatalError, fatalStack };
}

/**
 * Daily outcome-resolution job.
 * Never throws — failures are logged and the next cron tick proceeds.
 */
export async function resolveSignalOutcomesJob(): Promise<ResolveSignalOutcomesJobResult> {
  if (jobInFlight) {
    log.warn('resolveSignalOutcomesJob skipped — previous run still in flight');
    const startedAt = new Date();
    const finishedAt = new Date();
    const skipped: ResolveSignalOutcomesJobResult = {
      processed: 0,
      resolved: 0,
      active: 0,
      expired: 0,
      failed: 0,
      executionTimeMs: finishedAt.getTime() - startedAt.getTime(),
      skipped: true,
      ok: true,
      error: 'in_flight',
    };
    await logJobRun({
      startedAt,
      finishedAt,
      status: 'skipped',
      processedCount: 0,
      summary: { ...skipped, error: 'in_flight' },
    });
    return jobInFlight;
  }

  const startedAt = new Date();
  const promise = (async (): Promise<ResolveSignalOutcomesJobResult> => {
    if (await hasSuccessfulRunToday()) {
      const finishedAt = new Date();
      const skipped: ResolveSignalOutcomesJobResult = {
        processed: 0,
        resolved: 0,
        active: 0,
        expired: 0,
        failed: 0,
        executionTimeMs: finishedAt.getTime() - startedAt.getTime(),
        skipped: true,
        ok: true,
        error: 'already_completed_today',
      };

      log.info('resolveSignalOutcomesJob skipped — already completed successfully today');
      await logJobRun({
        startedAt,
        finishedAt,
        status: 'skipped',
        processedCount: 0,
        summary: skipped,
      });
      return skipped;
    }

    const limit = envNum('SIGNAL_OUTCOMES_JOB_LIMIT', 1, 10_000, 500);
    const timeoutMs = jobTimeoutMs();
    let step1: ResolveSignalOutcomesResult | undefined;
    let step2: ResolveSignalOutcomesResult | undefined;
    let fatalError: string | undefined;
    let fatalStack: string | undefined;
    let timedOut = false;

    try {
      const steps = await withTimeout(runJobSteps(limit), timeoutMs);
      step1 = steps.step1;
      step2 = steps.step2;
      fatalError = steps.fatalError;
      fatalStack = steps.fatalStack;
    } catch (err) {
      const { message, stack } = formatError(err);
      fatalError = message;
      fatalStack = stack;
      timedOut = err instanceof JobTimeoutError;
      log.error('resolveSignalOutcomesJob aborted', { err: message, stack, timedOut });
    }

    const finishedAt = new Date();
    const executionTimeMs = finishedAt.getTime() - startedAt.getTime();

    if (timedOut) {
      const failed: ResolveSignalOutcomesJobResult = {
        processed: (step1?.processed ?? 0) + (step2?.processed ?? 0),
        resolved: 0,
        active: 0,
        expired: 0,
        failed: 1,
        executionTimeMs,
        skipped: false,
        ok: false,
        timedOut: true,
        step1,
        step2,
        error: fatalError,
      };

      await logJobRun({
        startedAt,
        finishedAt,
        status: 'failed',
        processedCount: failed.processed,
        summary: failed,
        errorMessage: fatalStack ?? fatalError,
      });
      return failed;
    }

    if (!step1 && !step2) {
      const failed: ResolveSignalOutcomesJobResult = {
        processed: 0,
        resolved: 0,
        active: 0,
        expired: 0,
        failed: 1,
        executionTimeMs,
        skipped: false,
        ok: false,
        error: fatalError,
      };

      await logJobRun({
        startedAt,
        finishedAt,
        status: 'failed',
        processedCount: 0,
        summary: failed,
        errorMessage: fatalStack ?? fatalError,
      });
      return failed;
    }

    const merged = mergeStepResults(
      step1 ?? emptyStepResult(fatalError ? 1 : 0),
      step2 ?? emptyStepResult(fatalError ? 1 : 0),
    );

    const ok = !fatalError && merged.failed === 0 && executionTimeMs <= timeoutMs;
    const result: ResolveSignalOutcomesJobResult = {
      ...merged,
      executionTimeMs,
      skipped: false,
      ok,
      step1,
      step2,
      error: fatalError,
    };

    if (ok) {
      clearOutcomeResolutionCaches();
    }

    await logJobRun({
      startedAt,
      finishedAt,
      status: ok ? 'success' : 'failed',
      processedCount: merged.processed,
      summary: result,
      errorMessage: fatalStack ?? fatalError,
    });

    log.info('resolveSignalOutcomesJob complete', {
      processed: result.processed,
      resolved: result.resolved,
      active: result.active,
      expired: result.expired,
      failed: result.failed,
      executionTimeMs: result.executionTimeMs,
      ok: result.ok,
    });

    return result;
  })().finally(() => {
    jobInFlight = null;
  });

  jobInFlight = promise;
  return promise;
}
