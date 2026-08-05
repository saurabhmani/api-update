import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.hoisted(() => vi.fn());
const acquireLock = vi.hoisted(() => vi.fn());
const releaseLock = vi.hoisted(() => vi.fn());
const dailyUpdate = vi.hoisted(() => vi.fn());
const morningScan = vi.hoisted(() => vi.fn());
const eveningScan = vi.hoisted(() => vi.fn());
const childInfo = vi.hoisted(() => vi.fn());
const childError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ db: { query: dbQuery } }));
vi.mock('@/lib/redis', () => ({
  cacheAcquireLock: acquireLock,
  cacheReleaseLock: releaseLock,
}));
vi.mock('@/lib/marketData/candleDailyUpdateJob', () => ({
  runCandleDailyUpdateJob: dailyUpdate,
}));
vi.mock('@/lib/workers/dailyScanSchedule', () => ({
  runFirstMorningScanJob: morningScan,
  runEveningScanJob: eveningScan,
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      info: childInfo,
      warn: vi.fn(),
      error: childError,
      debug: vi.fn(),
    }),
  },
}));

import {
  maybeRunSignalsDatabaseBootstrap,
  resetSignalsDatabaseBootstrapForTests,
  scheduleSignalsDatabaseBootstrap,
  SignalsCountQueryError,
} from '@/lib/startup/signalsDatabaseBootstrap';

describe('signalsDatabaseBootstrap', () => {
  beforeEach(() => {
    resetSignalsDatabaseBootstrapForTests();
    dbQuery.mockReset();
    acquireLock.mockReset();
    releaseLock.mockReset();
    dailyUpdate.mockReset();
    morningScan.mockReset();
    eveningScan.mockReset();
    childInfo.mockReset();
    childError.mockReset();
    process.env.SIGNALS_DATABASE_BOOTSTRAP_ENABLED = 'true';
    acquireLock.mockResolvedValue(true);
    releaseLock.mockResolvedValue(undefined);
    dailyUpdate.mockResolvedValue({});
    morningScan.mockResolvedValue({ ok: true });
    eveningScan.mockResolvedValue({ ok: true });
  });

  it('skips when q365_signals already has rows', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 5 }] });
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result).toMatchObject({ ran: false, skipped: 'signals_present', signalCountBefore: 5 });
    expect(dailyUpdate).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('runs pipeline sequentially on startup when empty and lock acquired', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result.ran).toBe(true);
    expect(dailyUpdate).toHaveBeenCalled();
    expect(morningScan).toHaveBeenCalled();
    expect(eveningScan).toHaveBeenCalled();
    expect(dailyUpdate.mock.invocationCallOrder[0]).toBeLessThan(morningScan.mock.invocationCallOrder[0]);
    expect(morningScan.mock.invocationCallOrder[0]).toBeLessThan(eveningScan.mock.invocationCallOrder[0]);
    expect(releaseLock).toHaveBeenCalledWith('q365:signals-database-bootstrap', expect.any(String));
    expect(childInfo).toHaveBeenCalledWith(
      'Empty signals database detected — bootstrap starting',
      expect.objectContaining({ event: 'signals_bootstrap_triggered', trigger: 'startup' }),
    );
  });

  it('runs pipeline on api-empty-read trigger (product cold start)', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    const result = await maybeRunSignalsDatabaseBootstrap({
      trigger: 'api-empty-read',
      userId: 1,
    });
    expect(result.ran).toBe(true);
    expect(dailyUpdate).toHaveBeenCalled();
    expect(morningScan).toHaveBeenCalled();
    expect(eveningScan).toHaveBeenCalled();
    expect(childInfo).toHaveBeenCalledWith(
      'Empty signals database detected — bootstrap starting',
      expect.objectContaining({
        trigger: 'api-empty-read',
        reason: 'signals_api_empty_db_indianapi_fill',
      }),
    );
  });

  it('re-checks signal count after acquiring the lock', async () => {
    let calls = 0;
    dbQuery.mockImplementation(async () => {
      calls += 1;
      // 1st: pre-lock empty, 2nd: after-lock populated
      return { rows: [{ total: calls === 1 ? 0 : 3 }] };
    });
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result).toMatchObject({ ran: false, skipped: 'signals_present', signalCountBefore: 3 });
    expect(dailyUpdate).not.toHaveBeenCalled();
  });

  it('isolates step failures and continues', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    dailyUpdate.mockRejectedValue(new Error('candle fail'));
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result.ran).toBe(true);
    expect(morningScan).toHaveBeenCalled();
    expect(eveningScan).toHaveBeenCalled();
    expect(result.steps?.find((s) => s.step === 'daily-candle-update')?.ok).toBe(false);
  });

  it('skips when lock is held by another worker', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    acquireLock.mockResolvedValue(false);
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result).toMatchObject({ ran: false, skipped: 'lock_held' });
    expect(dailyUpdate).not.toHaveBeenCalled();
  });

  it('releases lock with ownership token only', async () => {
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    const [key, token] = releaseLock.mock.calls[0];
    expect(key).toBe('q365:signals-database-bootstrap');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
  });

  it('treats database query failures separately from an empty table', async () => {
    dbQuery.mockRejectedValue(new Error('connection refused'));
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result).toMatchObject({ ran: false, skipped: 'db_error', signalCountBefore: -1 });
    expect(dailyUpdate).not.toHaveBeenCalled();
    expect(childError).toHaveBeenCalledWith(
      'Signals count query failed',
      expect.objectContaining({ event: 'signals_bootstrap_db_error' }),
    );
  });

  it('propagates SignalsCountQueryError from count helper', async () => {
    dbQuery.mockRejectedValue(new Error('timeout'));
    await expect(
      import('@/lib/startup/signalsDatabaseBootstrap').then((m) => m.countQ365Signals()),
    ).rejects.toBeInstanceOf(SignalsCountQueryError);
  });

  it('respects SIGNALS_DATABASE_BOOTSTRAP_ENABLED=false', async () => {
    process.env.SIGNALS_DATABASE_BOOTSTRAP_ENABLED = 'false';
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result.skipped).toBe('disabled');
    expect(dailyUpdate).not.toHaveBeenCalled();
  });

  it('coalesces duplicate startup-style bootstrap schedules into one in-flight run', async () => {
    let resolveDaily: () => void = () => {};
    dailyUpdate.mockImplementation(
      () => new Promise<void>((resolve) => { resolveDaily = resolve; }),
    );
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }] });

    // Broker connect no longer triggers bootstrap — use startup / api-empty-read.
    scheduleSignalsDatabaseBootstrap({ trigger: 'startup' });
    scheduleSignalsDatabaseBootstrap({ trigger: 'api-empty-read', userId: 1 });

    await vi.waitFor(() => {
      expect(dailyUpdate).toHaveBeenCalledTimes(1);
    });

    resolveDaily();
    await vi.waitFor(() => {
      expect(releaseLock).toHaveBeenCalled();
    });
  });

  it('skips evening scan when morning scan populates signals', async () => {
    let calls = 0;
    dbQuery.mockImplementation(async () => {
      calls += 1;
      // counts after candle + after morning
      const total = calls >= 4 ? 2 : 0;
      return { rows: [{ total }] };
    });
    const result = await maybeRunSignalsDatabaseBootstrap({ trigger: 'startup' });
    expect(result.ran).toBe(true);
    expect(eveningScan).not.toHaveBeenCalled();
  });
});
