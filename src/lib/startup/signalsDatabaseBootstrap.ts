// Empty q365_signals bootstrap — runs daily candle update then morning/evening scans.
// Idempotent: skips when signals already exist; uses distributed lock + in-process coalescing.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cacheAcquireLock, cacheReleaseLock } from '@/lib/redis';
import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
import { runFirstMorningScanJob, runEveningScanJob } from '@/lib/workers/dailyScanSchedule';

const log = logger.child({ component: 'signalsDatabaseBootstrap' });
const LOCK_KEY = 'q365:signals-database-bootstrap';
const LOCK_TTL_S = 3600;

export type SignalsBootstrapTrigger =
  | 'startup'
  | 'data-source-connected'
  /** Empty q365_signals detected while serving /api/signals (product cold start). */
  | 'api-empty-read';

export interface SignalsBootstrapContext {
  trigger: SignalsBootstrapTrigger;
  broker?: string;
  userId?: number;
}

export type SignalsBootstrapSkipReason =
  | 'signals_present'
  | 'lock_held'
  | 'coalesced'
  | 'disabled'
  | 'db_error';

export interface SignalsBootstrapResult {
  ran: boolean;
  skipped?: SignalsBootstrapSkipReason;
  trigger: SignalsBootstrapTrigger;
  signalCountBefore: number;
  signalCountAfter?: number;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
  error?: string;
}

let coalescedRun: Promise<SignalsBootstrapResult> | null = null;

/** Thrown when q365_signals count cannot be read — distinct from an empty table. */
export class SignalsCountQueryError extends Error {
  constructor(cause: unknown) {
    super('Failed to query q365_signals row count');
    this.name = 'SignalsCountQueryError';
    this.cause = cause;
  }
}

export async function countQ365Signals(): Promise<number> {
  try {
    const { rows } = await db.query('SELECT COUNT(*) AS total FROM q365_signals');
    const raw = rows[0]?.total ?? rows[0]?.TOTAL ?? 0;
    return Number(raw) || 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Signals count query failed', {
      event: 'signals_bootstrap_db_error',
      error: message,
    });
    throw new SignalsCountQueryError(err);
  }
}

function isBootstrapEnabled(): boolean {
  const raw = (process.env.SIGNALS_DATABASE_BOOTSTRAP_ENABLED ?? 'true').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function triggerReason(ctx: SignalsBootstrapContext): string {
  if (ctx.trigger === 'startup') return 'application_startup_empty_signals';
  if (ctx.trigger === 'api-empty-read') return 'signals_api_empty_db_indianapi_fill';
  return 'data_source_connected_empty_signals';
}

async function runPipelineSteps(runId: string): Promise<Array<{ step: string; ok: boolean; error?: string }>> {
  const steps: Array<{ step: string; ok: boolean; error?: string }> = [];
  const runStep = async (step: string, fn: () => Promise<unknown>) => {
    log.info('Signals bootstrap job starting', { event: 'signals_bootstrap_job_start', runId, step });
    try {
      await fn();
      steps.push({ step, ok: true });
      log.info('Signals bootstrap job completed', { event: 'signals_bootstrap_job_complete', runId, step });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error('Signals bootstrap job failed (continuing)', {
        event: 'signals_bootstrap_job_failure',
        runId,
        step,
        error,
      });
      steps.push({ step, ok: false, error });
    }
  };

  // Prefer IndianAPI for empty-DB candle fill when enabled. With no
  // connected broker, candleDailyUpdateJob resolves upstream to IndianAPI.
  const { isIndianApiEnabled, indianApiCredentialsPresent } = await import(
    '@/lib/marketData/providerFlags'
  );
  if (isIndianApiEnabled() && indianApiCredentialsPresent()) {
    log.info('Empty DB fill will use IndianAPI for candle ingest', {
      event: 'signals_bootstrap_indianapi_fill',
      runId,
    });
  }

  await runStep('daily-candle-update', () => runCandleDailyUpdateJob());
  const afterCandles = await countQ365Signals();
  if (afterCandles > 0) {
    log.info('Signals present after candle update — skipping scans', {
      event: 'signals_bootstrap_skip_scans',
      runId,
      signalCount: afterCandles,
    });
    return steps;
  }
  await runStep('morning-scan', () => runFirstMorningScanJob());
  const afterMorning = await countQ365Signals();
  if (afterMorning > 0) {
    log.info('Signals present after morning scan — skipping evening scan', {
      event: 'signals_bootstrap_skip_evening',
      runId,
      signalCount: afterMorning,
    });
    return steps;
  }
  await runStep('evening-scan', () => runEveningScanJob());
  return steps;
}

async function runBootstrapInner(ctx: SignalsBootstrapContext): Promise<SignalsBootstrapResult> {
  let signalCountBefore: number;
  try {
    signalCountBefore = await countQ365Signals();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ran: false,
      skipped: 'db_error',
      trigger: ctx.trigger,
      signalCountBefore: -1,
      error: message,
    };
  }

  if (signalCountBefore > 0) {
    log.info('Skipping signals bootstrap — table already populated', {
      event: 'signals_bootstrap_skip',
      trigger: ctx.trigger,
      broker: ctx.broker,
      userId: ctx.userId,
      signalCount: signalCountBefore,
      reason: 'signals_present',
    });
    return { ran: false, skipped: 'signals_present', trigger: ctx.trigger, signalCountBefore };
  }

  log.info('Empty signals database detected — bootstrap starting', {
    event: 'signals_bootstrap_triggered',
    trigger: ctx.trigger,
    broker: ctx.broker,
    userId: ctx.userId,
    reason: triggerReason(ctx),
  });

  const runId = randomUUID();
  const lockToken = randomUUID();
  const acquired = await cacheAcquireLock(LOCK_KEY, lockToken, LOCK_TTL_S);
  if (!acquired) {
    if (coalescedRun) {
      log.info('Signals bootstrap coalesced with in-flight run', {
        event: 'signals_bootstrap_coalesced',
        trigger: ctx.trigger,
        broker: ctx.broker,
      });
      return coalescedRun;
    }
    log.info('Signals bootstrap skipped — distributed lock held by another worker', {
      event: 'signals_bootstrap_lock_held',
      trigger: ctx.trigger,
      lockKey: LOCK_KEY,
    });
    return { ran: false, skipped: 'lock_held', trigger: ctx.trigger, signalCountBefore };
  }

  log.info('Signals bootstrap lock acquired', {
    event: 'signals_bootstrap_lock_acquired',
    trigger: ctx.trigger,
    runId,
    lockKey: LOCK_KEY,
    ttlSeconds: LOCK_TTL_S,
  });

  try {
    const again = await countQ365Signals();
    if (again > 0) {
      log.info('Signals appeared while waiting for lock — skipping bootstrap', {
        event: 'signals_bootstrap_skip',
        trigger: ctx.trigger,
        signalCount: again,
        reason: 'signals_present_after_lock',
      });
      return { ran: false, skipped: 'signals_present', trigger: ctx.trigger, signalCountBefore: again };
    }

    const steps = await runPipelineSteps(runId);
    const signalCountAfter = await countQ365Signals();
    log.info('Signals bootstrap finished', {
      event: 'signals_bootstrap_complete',
      trigger: ctx.trigger,
      runId,
      signalCountBefore,
      signalCountAfter,
      steps,
    });
    return { ran: true, trigger: ctx.trigger, signalCountBefore, signalCountAfter, steps };
  } finally {
    await cacheReleaseLock(LOCK_KEY, lockToken);
    log.info('Signals bootstrap lock released', {
      event: 'signals_bootstrap_lock_released',
      trigger: ctx.trigger,
      runId,
      lockKey: LOCK_KEY,
    });
  }
}

export function scheduleSignalsDatabaseBootstrap(ctx: SignalsBootstrapContext): void {
  if (!isBootstrapEnabled()) {
    log.debug('Signals bootstrap scheduling skipped — feature disabled', {
      event: 'signals_bootstrap_disabled',
      trigger: ctx.trigger,
    });
    return;
  }
  if (coalescedRun) {
    log.info('Signals bootstrap schedule coalesced — run already in flight', {
      event: 'signals_bootstrap_coalesced',
      trigger: ctx.trigger,
      broker: ctx.broker,
    });
    void coalescedRun;
    return;
  }
  coalescedRun = maybeRunSignalsDatabaseBootstrap(ctx).finally(() => { coalescedRun = null; });
}

export async function maybeRunSignalsDatabaseBootstrap(
  ctx: SignalsBootstrapContext,
): Promise<SignalsBootstrapResult> {
  if (!isBootstrapEnabled()) {
    log.info('Signals bootstrap disabled via SIGNALS_DATABASE_BOOTSTRAP_ENABLED', {
      event: 'signals_bootstrap_disabled',
      trigger: ctx.trigger,
    });
    return {
      ran: false,
      skipped: 'disabled',
      trigger: ctx.trigger,
      signalCountBefore: await countQ365Signals().catch(() => -1),
    };
  }
  return runBootstrapInner(ctx);
}

export function resetSignalsDatabaseBootstrapForTests(): void {
  coalescedRun = null;
}
