/**
 * Manipulation daily scan scheduler — registration + trigger + logging.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { DailyScanResult } from '@/lib/manipulation-engine/pipeline/runDailyScan';

const scheduledJobs: Array<{
  cron: string;
  fn: () => void;
  opts: { timezone: string };
  stop: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((cronExpr: string, fn: () => void, opts: { timezone: string }) => {
      const stop = vi.fn();
      scheduledJobs.push({ cron: cronExpr, fn, opts, stop });
      return { stop };
    }),
  },
}));

vi.mock('@/lib/manipulation-engine/pipeline/runDailyScan', () => ({
  runDailyScan: vi.fn(),
}));

vi.mock('@/lib/marketData/candleDailyUpdateJob', () => ({
  runCandleDailyUpdateJob: vi.fn(),
}));
vi.mock('@/lib/marketData/candleFallbackChain', () => ({
  fetchDailyCandlesWithFallback: vi.fn(),
  resetCandleSourceCounters: vi.fn(),
  getIndianApiCandleRequestCount: vi.fn(() => 0),
}));
vi.mock('@/lib/marketData/eod/eodIngestionPipeline', () => ({
  runDailyEodIngestion: vi.fn(),
}));
vi.mock('@/lib/signal-engine', () => ({
  generatePhase4Signals: vi.fn(),
  DEFAULT_PHASE3_CONFIG: { defaultCapital: 1_000_000 },
}));
vi.mock('@/lib/signal-engine/constants/signalEngine.constants', () => ({
  DEFAULT_PHASE1_CONFIG: { universe: [] },
  loadTradeableUniverse: vi.fn(async () => []),
}));
vi.mock('@/lib/startup/ensureUniverseReady', () => ({
  ensureUniverseReady: vi.fn(async () => ({ ok: true, error: null })),
}));
vi.mock('@/lib/marketData/providers/batchScheduler', () => ({
  markPipelineHeartbeat: vi.fn(),
}));
vi.mock('@/lib/marketData/providerRequestPolicy', () => ({
  DAILY_UPDATE_MAX_REQUESTS: () => 50,
}));

import { runDailyScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';
import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
import { fetchDailyCandlesWithFallback } from '@/lib/marketData/candleFallbackChain';
import { runDailyEodIngestion } from '@/lib/marketData/eod/eodIngestionPipeline';
import {
  startDailyScanSchedule,
  stopDailyScanSchedule,
  runManipulationDailyScanJob,
  DAILY_SCAN_TIMEZONE,
  DAILY_SCHEDULE_CRONS,
  cronIstMinutesFromMidnight,
  isManipulationScheduledAfterEodUpdate,
} from '@/lib/workers/dailyScanSchedule';

const EOD_UPDATE_CRON = '0 16 * * 1-5';
const MANIPULATION_CRON = '30 18 * * 1-5';

const successResult = (): DailyScanResult => ({
  ok:              true,
  startedAt:       '2026-06-23T13:00:00.000Z',
  completedAt:     '2026-06-23T13:05:00.000Z',
  candlesAdvanced: false,
  candleDateBefore: '2026-06-23',
  candleDateAfter:  '2026-06-23',
  ingestion:        null,
  scan: {
    skipped:             false,
    scanned:             502,
    snapshotsPersisted:  500,
    skippedInsufficient: 2,
    failed:              0,
    bandCounts:          { low: 480, watch: 10, elevated: 8, high: 2, severe: 2 },
    penaltiesWritten:    3,
    durationMs:          120_000,
  },
  latestEventDate: '2026-06-23',
  reason:          'Manipulation scan complete.',
  warnings:        [],
});

function manipulationJob() {
  const job = scheduledJobs.find((j) => j.cron === MANIPULATION_CRON);
  expect(job).toBeDefined();
  return job!;
}

describe('dailyScanSchedule — manipulation scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduledJobs.length = 0;
    stopDailyScanSchedule();
    process.env.DAILY_SCAN_SCHEDULE_ENABLED = 'true';
    delete process.env.SIGNAL_LEGACY_EVENING_SCAN_1830;
    delete process.env.MANIPULATION_DAILY_SCAN_CRON;
  });

  afterEach(() => {
    stopDailyScanSchedule();
    scheduledJobs.length = 0;
  });

  it('1.1 — startDailyScanSchedule registers one additional manipulation cron task', () => {
    const baselineCronJobs = ['30 8 * * 1-5', '0 16 * * 1-5', '30 16 * * 1-5'];

    startDailyScanSchedule();

    expect(scheduledJobs).toHaveLength(baselineCronJobs.length + 1);
    for (const expr of baselineCronJobs) {
      expect(scheduledJobs.some((j) => j.cron === expr)).toBe(true);
    }
    const manip = manipulationJob();
    expect(manip.opts.timezone).toBe(DAILY_SCAN_TIMEZONE);
  });

  it('1.2 — 18:30 IST trigger executes runDailyScan({ skipIngestion: true })', async () => {
    vi.mocked(runDailyScan).mockResolvedValue(successResult());

    startDailyScanSchedule();
    const { fn } = manipulationJob();
    fn();
    await vi.waitFor(() => expect(runDailyScan).toHaveBeenCalled());

    expect(runDailyScan).toHaveBeenCalledWith({ skipIngestion: true });
    expect(runDailyScan).toHaveBeenCalledTimes(1);
  });

  it('1.3 — successful scan logs started and complete', async () => {
    vi.mocked(runDailyScan).mockResolvedValue(successResult());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runManipulationDailyScanJob();

    expect(logSpy).toHaveBeenCalledWith('[manipulation] daily scan started');
    expect(logSpy).toHaveBeenCalledWith(
      '[manipulation] daily scan complete',
      expect.objectContaining({ snapshotsPersisted: 500 }),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[manipulation] daily scan failed',
      expect.anything(),
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('1.4 — scanner throw logs failed; scheduler remains running', async () => {
    vi.mocked(runDailyScan).mockRejectedValue(new Error('scanner DB unreachable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    startDailyScanSchedule();
    const taskCountBefore = scheduledJobs.length;

    manipulationJob().fn();
    await vi.waitFor(() => expect(runDailyScan).toHaveBeenCalled());
    await vi.waitFor(() =>
      errorSpy.mock.calls.some((call) => call[0] === '[manipulation] daily scan failed'),
    );

    expect(errorSpy).toHaveBeenCalledWith(
      '[manipulation] daily scan failed',
      expect.objectContaining({ error: 'scanner DB unreachable' }),
    );
    expect(scheduledJobs).toHaveLength(taskCountBefore);
    expect(manipulationJob().stop).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  describe('Test 2 — schedule contract', () => {
    it('2.1 — cron timings: 16:00 EOD update, 18:30 manipulation scan', () => {
      startDailyScanSchedule();

      const eodJob = scheduledJobs.find((j) => j.cron === EOD_UPDATE_CRON);
      const manipJob = scheduledJobs.find((j) => j.cron === MANIPULATION_CRON);

      expect(eodJob).toBeDefined();
      expect(manipJob).toBeDefined();
      expect(DAILY_SCHEDULE_CRONS.eveningUpdate).toBe(EOD_UPDATE_CRON);
      expect(DAILY_SCHEDULE_CRONS.manipulationDailyScan).toBe(MANIPULATION_CRON);
      expect(cronIstMinutesFromMidnight(EOD_UPDATE_CRON)).toBe(16 * 60);
      expect(cronIstMinutesFromMidnight(MANIPULATION_CRON)).toBe(18 * 60 + 30);
      expect(isManipulationScheduledAfterEodUpdate()).toBe(true);
    });

    it('2.2 — execution path always passes skipIngestion: true', async () => {
      vi.mocked(runDailyScan).mockResolvedValue(successResult());

      // Direct job entry point
      await runManipulationDailyScanJob();
      expect(runDailyScan).toHaveBeenLastCalledWith({ skipIngestion: true });

      vi.clearAllMocks();
      vi.mocked(runDailyScan).mockResolvedValue(successResult());

      // Cron trigger entry point
      startDailyScanSchedule();
      manipulationJob().fn();
      await vi.waitFor(() => expect(runDailyScan).toHaveBeenCalled());
      expect(runDailyScan).toHaveBeenCalledWith({ skipIngestion: true });
      for (const call of vi.mocked(runDailyScan).mock.calls) {
        expect(call[0]).toEqual({ skipIngestion: true });
      }
    });

    it('2.3 — manipulation scheduler never calls market-data APIs', async () => {
      vi.mocked(runDailyScan).mockResolvedValue(successResult());

      await runManipulationDailyScanJob();

      expect(runCandleDailyUpdateJob).not.toHaveBeenCalled();
      expect(fetchDailyCandlesWithFallback).not.toHaveBeenCalled();
      expect(runDailyEodIngestion).not.toHaveBeenCalled();
    });
  });

  describe('schedule ordering & race guards', () => {
    it('3.1 — default crons place manipulation scan after 16:00 EOD update', () => {
      const eod = cronIstMinutesFromMidnight(DAILY_SCHEDULE_CRONS.eveningUpdate);
      const manip = cronIstMinutesFromMidnight(DAILY_SCHEDULE_CRONS.manipulationDailyScan);

      expect(eod).toBe(16 * 60);           // 16:00 IST
      expect(manip).toBe(18 * 60 + 30);    // 18:30 IST
      expect(manip).toBeGreaterThan(eod);
      expect(isManipulationScheduledAfterEodUpdate()).toBe(true);
    });

    it('3.2 — misconfigured cron fails ordering check', () => {
      expect(
        isManipulationScheduledAfterEodUpdate({
          eveningUpdate: '0 16 * * 1-5',
          eveningScan: '30 16 * * 1-5',
          manipulationDailyScan: '0 15 * * 1-5', // before EOD
        }),
      ).toBe(false);
    });

    it('3.3 — concurrent manipulation ticks share one in-flight run', async () => {
      let resolveScan!: (v: DailyScanResult) => void;
      const pending = new Promise<DailyScanResult>((resolve) => {
        resolveScan = resolve;
      });
      vi.mocked(runDailyScan).mockReturnValue(pending);

      const first = runManipulationDailyScanJob();
      const second = runManipulationDailyScanJob();

      expect(runDailyScan).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);

      resolveScan(successResult());
      await Promise.all([first, second]);
    });

    it('3.4 — duplicate startDailyScanSchedule does not register extra crons', () => {
      startDailyScanSchedule();
      const countAfterFirst = scheduledJobs.length;

      startDailyScanSchedule();
      expect(scheduledJobs).toHaveLength(countAfterFirst);
    });
  });
});
