/**
 * resolveSignalOutcomesJob — acceptance criteria (scheduler contract).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const logCronJob = vi.fn(async (..._args: unknown[]) => {});
const invalidateStreamSignalsCache = vi.fn();
const invalidatePublicSignalsCache = vi.fn(async () => 0);
const resolveSignalOutcomes = vi.fn();
const refreshActiveSignalOutcomes = vi.fn();
const dbQuery = vi.fn();

vi.mock('@/lib/db', () => ({
  db: { query: (...args: unknown[]) => dbQuery(...args) },
}));

vi.mock('@/lib/admin/repository/adminMonitoringRepository', () => ({
  logCronJob: (...args: unknown[]) => logCronJob(...args),
}));

vi.mock('@/lib/signals/streamSignalsCache', () => ({
  invalidateStreamSignalsCache: () => invalidateStreamSignalsCache(),
}));

vi.mock('@/lib/signals/public/publicSignalsService', () => ({
  invalidatePublicSignalsCache: () => invalidatePublicSignalsCache(),
}));

vi.mock('@/lib/signals/outcome/resolveSignalOutcomes', () => ({
  resolveSignalOutcomes: (...args: unknown[]) => resolveSignalOutcomes(...args),
  refreshActiveSignalOutcomes: (...args: unknown[]) => refreshActiveSignalOutcomes(...args),
}));

import {
  resolveSignalOutcomesJob,
  hasSuccessfulRunToday,
  clearOutcomeResolutionCaches,
  RESOLVE_SIGNAL_OUTCOMES_JOB_NAME,
  RESOLVE_SIGNAL_OUTCOMES_JOB_CRON,
  RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS,
  jobTimeoutMs,
} from '@/lib/signals/outcome/resolveSignalOutcomesJob';

const stepOk = () => ({
  processed: 2,
  inserted: 1,
  updated: 1,
  skippedTerminal: 0,
  skippedNoPlan: 0,
  skippedNoCandles: 0,
  errors: 0,
  targetHits: 1,
  stopLosses: 0,
  active: 1,
  expired: 0,
  elapsedMs: 50,
});

describe('resolveSignalOutcomesJob acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQuery.mockResolvedValue({ rows: [] });
    resolveSignalOutcomes.mockResolvedValue(stepOk());
    refreshActiveSignalOutcomes.mockResolvedValue(stepOk());
    delete process.env.SIGNAL_OUTCOMES_JOB_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers daily cron contract constants', () => {
    expect(RESOLVE_SIGNAL_OUTCOMES_JOB_CRON).toBe('30 16 * * 1-5');
    expect(RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(jobTimeoutMs()).toBe(10 * 60 * 1000);
  });

  it('logs every successful execution with summary counts', async () => {
    const result = await resolveSignalOutcomesJob();

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(4);
    expect(result.resolved).toBe(2);
    expect(logCronJob).toHaveBeenCalledTimes(1);
    expect(logCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: RESOLVE_SIGNAL_OUTCOMES_JOB_NAME,
        status: 'success',
        metadata: expect.objectContaining({
          processed_count: 4,
          timeout_ms: 600_000,
        }),
      }),
    );
    expect(invalidateStreamSignalsCache).toHaveBeenCalledTimes(1);
    expect(invalidatePublicSignalsCache).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate successful runs on the same IST day', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });

    const result = await resolveSignalOutcomesJob();

    expect(result.skipped).toBe(true);
    expect(result.error).toBe('already_completed_today');
    expect(resolveSignalOutcomes).not.toHaveBeenCalled();
    expect(logCronJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('logs step failures without throwing (error handling)', async () => {
    resolveSignalOutcomes.mockRejectedValue(new Error('step1 boom'));
    refreshActiveSignalOutcomes.mockRejectedValue(new Error('step2 boom'));

    const result = await resolveSignalOutcomesJob();

    expect(result.ok).toBe(false);
    expect(logCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('step2 boom'),
      }),
    );
    expect(invalidateStreamSignalsCache).not.toHaveBeenCalled();
  });

  it('aborts when execution exceeds the 10-minute timeout', async () => {
    vi.useFakeTimers();
    resolveSignalOutcomes.mockImplementation(
      () => new Promise(() => {}),
    );

    const pending = resolveSignalOutcomesJob();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(logCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('600000ms timeout'),
      }),
    );
    expect(invalidateStreamSignalsCache).not.toHaveBeenCalled();
  });

  it('clearOutcomeResolutionCaches invalidates stream and public caches', () => {
    clearOutcomeResolutionCaches();
    expect(invalidateStreamSignalsCache).toHaveBeenCalledTimes(1);
    expect(invalidatePublicSignalsCache).toHaveBeenCalledTimes(1);
  });

  it('hasSuccessfulRunToday queries cron_job_logs with IST calendar date', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await expect(hasSuccessfulRunToday()).resolves.toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining('CONVERT_TZ'),
      expect.arrayContaining([RESOLVE_SIGNAL_OUTCOMES_JOB_NAME, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]),
    );
  });
});
