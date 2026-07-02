// ════════════════════════════════════════════════════════════════
//  Daily scan schedule — controlled IST signal cadence (Mon–Fri).
//
//  EXECUTION ORDER (wall-clock IST, Mon–Fri):
//    08:30  Readiness check     — universe + candle coverage only (no signals)
//    09:20  First morning scan  — DB-only Phase 4 full universe
//    09:45  Main morning scan   — DB-only Phase 4 full universe
//    12:30  Midday rescore      — active signal rescore only
//    14:45  Late rescore        — active signal rescore / light confirmation
//    16:00  Evening update      — IndianAPI incremental EOD candle fetch
//    16:30  Evening scan        — DB-only Phase 4 post-EOD signals
//    18:30  Manipulation scan   — runDailyScan({ skipIngestion: true })
//
//  Env:
//    DAILY_SCAN_SCHEDULE_ENABLED=true|false
//    PREOPEN_CANDLE_WARMUP_ENABLED=false
//    SIGNAL_INTRADAY_REGEN_ENABLED=false
//    SIGNALS_AUTO_RECOVERY_ENABLED=false
//    SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ=false
//    READINESS_CHECK_CRON, FIRST_MORNING_SCAN_CRON, MAIN_MORNING_SCAN_CRON, ...
//
//  Docs: docs/DAILY_SCAN_SCHEDULE.md
// ════════════════════════════════════════════════════════════════

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger';
import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
import {
  fetchDailyCandlesWithFallback,
  resetCandleSourceCounters,
  getIndianApiCandleRequestCount,
} from '@/lib/marketData/candleFallbackChain';
import {
  generatePhase4Signals,
  DEFAULT_PHASE3_CONFIG,
  type CandleProvider,
  type Candle,
  type PortfolioSnapshot,
} from '@/lib/signal-engine';
import {
  DEFAULT_PHASE1_CONFIG,
  loadTradeableUniverse,
} from '@/lib/signal-engine/constants/signalEngine.constants';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import { markPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';
import { DAILY_UPDATE_MAX_REQUESTS } from '@/lib/marketData/providerRequestPolicy';
import {
  runDailyScan,
  type DailyScanResult,
} from '@/lib/manipulation-engine/pipeline/runDailyScan';
import { rescoreActiveSignals } from '@/lib/signal-engine/rescore/rescoreActiveSignals';
import { runScanReadinessCheck } from '@/lib/signal-engine/schedule/scanReadinessCheck';
import {
  isDailyScanScheduleEnabled,
  resolveControlledSignalCrons,
  SIGNAL_SCHEDULE_TIMEZONE,
} from '@/lib/signal-engine/schedule/signalSchedulePolicy';

const log = logger.child({ component: 'dailyScanSchedule' });
export const DAILY_SCAN_TIMEZONE = SIGNAL_SCHEDULE_TIMEZONE;

/** Default cron expressions — minute hour dom month dow (IST). */
export const DAILY_SCHEDULE_CRONS = {
  readinessCheck:        '30 8 * * 1-5',
  firstMorningScan:      '20 9 * * 1-5',
  mainMorningScan:       '45 9 * * 1-5',
  middayRescore:         '30 12 * * 1-5',
  lateRescore:           '45 14 * * 1-5',
  eveningUpdate:         '0 16 * * 1-5',
  eveningScan:           '30 16 * * 1-5',
  manipulationDailyScan: '30 18 * * 1-5',
  /** @deprecated use firstMorningScan */
  morningScan:           '20 9 * * 1-5',
} as const;

/** Parse `minute hour * * *` cron into minutes-from-midnight (IST wall clock). */
export function cronIstMinutesFromMidnight(expr: string): number {
  const [minuteStr, hourStr] = expr.trim().split(/\s+/);
  const minute = Number(minuteStr);
  const hour = Number(hourStr);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) {
    throw new Error(`Invalid cron time expression: ${expr}`);
  }
  return hour * 60 + minute;
}

/** Cron triple validated at schedule startup (evening update → scan → manipulation). */
export interface EveningScheduleCrons {
  eveningUpdate: string;
  eveningScan: string;
  manipulationDailyScan: string;
}

/** True when every later job fires strictly after `eveningUpdate` on the IST clock. */
export function isManipulationScheduledAfterEodUpdate(
  crons: EveningScheduleCrons = DAILY_SCHEDULE_CRONS,
): boolean {
  const eodMinutes = cronIstMinutesFromMidnight(crons.eveningUpdate);
  const eveningScanMinutes = cronIstMinutesFromMidnight(crons.eveningScan);
  const manipulationMinutes = cronIstMinutesFromMidnight(crons.manipulationDailyScan);
  return eveningScanMinutes > eodMinutes && manipulationMinutes > eodMinutes;
}

export type DailyJobMode = 'scan' | 'incremental-update' | 'readiness' | 'rescore';
export type DailyJobDataSource = 'db' | 'indianapi';

export interface DailyJobLogEntry {
  job_name: string;
  mode: DailyJobMode;
  data_source: DailyJobDataSource;
  start_time: string;
  end_time: string;
  duration_ms: number;
  total_symbols: number;
  scanned_symbols: number;
  requests_used: number;
  signals_generated: number;
  failed_symbols: number;
  ok: boolean;
  error?: string;
  /** Truncated failure detail for operators. */
  failed_sample?: Array<{ symbol: string; reason: string }>;
}

export interface DailyScanJobResult extends DailyJobLogEntry {
  generation_source?: string;
  target_trading_day?: string;
  skipped_already_updated?: number;
  candles_fetched?: number;
}

const tasks: ScheduledTask[] = [];
const inFlight = new Map<string, Promise<DailyScanJobResult>>();
let manipulationDailyScanInFlight: Promise<DailyScanResult> | null = null;

function envCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

function envEnabled(name: string, defaultOn = true): boolean {
  if (name === 'DAILY_SCAN_SCHEDULE_ENABLED') {
    return isDailyScanScheduleEnabled();
  }
  const raw = (process.env[name] ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

async function runRescoreJob(opts: {
  jobName: string;
  generationSource: string;
}): Promise<DailyScanJobResult> {
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  logDailyJobStart({
    job_name: opts.jobName,
    mode: 'rescore',
    data_source: 'db',
    start_time: startTime,
  });

  const result = await rescoreActiveSignals();
  const endMs = Date.now();
  const entry: DailyScanJobResult = {
    job_name: opts.jobName,
    mode: 'rescore',
    data_source: 'db',
    start_time: startTime,
    end_time: new Date(endMs).toISOString(),
    duration_ms: endMs - startMs,
    total_symbols: result.scanned,
    scanned_symbols: result.scanned,
    requests_used: 0,
    signals_generated: result.updated,
    failed_symbols: result.failedFetches,
    ok: true,
    generation_source: opts.generationSource,
  };
  logDailyJobComplete(entry);
  return entry;
}

async function runReadinessJob(): Promise<DailyScanJobResult> {
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  logDailyJobStart({
    job_name: 'readiness-check',
    mode: 'readiness',
    data_source: 'db',
    start_time: startTime,
  });

  const check = await runScanReadinessCheck();
  const endMs = Date.now();
  const entry: DailyScanJobResult = {
    job_name: 'readiness-check',
    mode: 'readiness',
    data_source: 'db',
    start_time: startTime,
    end_time: new Date(endMs).toISOString(),
    duration_ms: endMs - startMs,
    total_symbols: check.universeActive,
    scanned_symbols: check.universeActive,
    requests_used: 0,
    signals_generated: 0,
    failed_symbols: check.blockers.length,
    ok: check.ok,
    generation_source: 'cron:readiness-check',
    error: check.ok ? undefined : check.blockers.join('; '),
  };
  logDailyJobComplete(entry);
  return entry;
}

function logDailyJobStart(entry: Pick<DailyJobLogEntry, 'job_name' | 'mode' | 'data_source' | 'start_time'>): void {
  const payload = { event: 'start', ...entry };
  console.log('[DAILY_JOB]', payload);
  log.info('daily job start', payload);
}

function logDailyJobComplete(entry: DailyJobLogEntry): void {
  const payload = { event: 'complete', ...entry };
  console.log('[DAILY_JOB]', payload);
  if (entry.ok) {
    log.info('daily job complete', payload);
  } else {
    log.error('daily job failed', payload);
  }
}

function createDbOnlyScanProvider(): CandleProvider {
  return {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      const result = await fetchDailyCandlesWithFallback(symbol, {
        dbOnly: true,
        evaluationRead: true,
      });
      return result.candles;
    },
  };
}

async function prepareUniverse(): Promise<string[]> {
  const ready = await ensureUniverseReady();
  if (!ready.ok) {
    throw new Error(`UNIVERSE_NOT_READY: ${ready.error ?? 'unknown'}`);
  }
  await loadTradeableUniverse();
  return DEFAULT_PHASE1_CONFIG.universe;
}

async function runDbScanJob(opts: {
  jobName: string;
  generationSource: string;
}): Promise<DailyScanJobResult> {
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  logDailyJobStart({
    job_name: opts.jobName,
    mode: 'scan',
    data_source: 'db',
    start_time: startTime,
  });

  resetCandleSourceCounters();
  const universe = await prepareUniverse();
  const totalSymbols = universe.length;

  const portfolio: PortfolioSnapshot = {
    capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };

  const result = await generatePhase4Signals(
    createDbOnlyScanProvider(),
    portfolio,
    undefined,
    undefined,
    { ...DEFAULT_PHASE1_CONFIG, universe },
    undefined,
    { generationSource: opts.generationSource },
  );

  const insufficient = result.meta.rejectedInsufficientCandles;
  const scannedSymbols = Math.max(0, result.meta.scanned - insufficient);
  const requestsUsed = getIndianApiCandleRequestCount();
  const failedSymbols = insufficient;

  try {
    await markPipelineHeartbeat(opts.generationSource);
  } catch (err) {
    log.warn('pipeline heartbeat failed (non-fatal)', {
      job: opts.jobName,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const endMs = Date.now();
  const entry: DailyScanJobResult = {
    job_name: opts.jobName,
    mode: 'scan',
    data_source: 'db',
    start_time: startTime,
    end_time: new Date(endMs).toISOString(),
    duration_ms: endMs - startMs,
    total_symbols: totalSymbols,
    scanned_symbols: scannedSymbols,
    requests_used: requestsUsed,
    signals_generated: result.signals.length,
    failed_symbols: failedSymbols,
    ok: true,
    generation_source: opts.generationSource,
  };
  logDailyJobComplete(entry);
  return entry;
}

async function executeEveningUpdateJob(): Promise<DailyScanJobResult> {
  const jobName = 'evening-update';
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  logDailyJobStart({
    job_name: jobName,
    mode: 'incremental-update',
    data_source: 'indianapi',
    start_time: startTime,
  });

  const summary = await runCandleDailyUpdateJob({
    maxFetch: DAILY_UPDATE_MAX_REQUESTS(),
  });
  const endMs = Date.now();
  const failedSample = summary.failures.slice(0, 10).map((f) => ({
    symbol: f.symbol,
    reason: f.reason,
  }));

  const entry: DailyScanJobResult = {
    job_name: jobName,
    mode: 'incremental-update',
    data_source: 'indianapi',
    start_time: startTime,
    end_time: new Date(endMs).toISOString(),
    duration_ms: endMs - startMs,
    total_symbols: summary.totalSymbols,
    scanned_symbols: summary.fetched,
    requests_used: summary.requestsUsed,
    signals_generated: 0,
    failed_symbols: summary.failed,
    ok: true,
    target_trading_day: summary.targetTradingDay,
    skipped_already_updated: summary.skippedAlreadyUpdated,
    candles_fetched: summary.fetched,
    failed_sample: failedSample.length > 0 ? failedSample : undefined,
  };
  logDailyJobComplete(entry);
  return entry;
}

function guardJob<T extends DailyScanJobResult>(
  jobName: string,
  runner: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(jobName);
  if (existing) {
    log.warn('daily job skipped — previous run still in flight', { job_name: jobName });
    return existing as Promise<T>;
  }
  const promise = runner()
    .catch((err): T => {
      const endMs = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      const failed: DailyScanJobResult = {
        job_name: jobName,
        mode: jobName === 'evening-update' ? 'incremental-update' : 'scan',
        data_source: jobName === 'evening-update' ? 'indianapi' : 'db',
        start_time: new Date(endMs).toISOString(),
        end_time: new Date(endMs).toISOString(),
        duration_ms: 0,
        total_symbols: 0,
        scanned_symbols: 0,
        requests_used: 0,
        signals_generated: 0,
        failed_symbols: 0,
        ok: false,
        error: msg,
      };
      logDailyJobComplete(failed);
      throw err;
    })
    .finally(() => {
      inFlight.delete(jobName);
    });
  inFlight.set(jobName, promise);
  return promise;
}

/** 08:30 IST — readiness check only (no signal generation). */
export function runReadinessCheckJob(): Promise<DailyScanJobResult> {
  return guardJob('readiness-check', runReadinessJob);
}

/** 09:20 IST — first controlled full DB-only scan. */
export function runFirstMorningScanJob(): Promise<DailyScanJobResult> {
  return guardJob('first-morning-scan', () =>
    runDbScanJob({
      jobName: 'first-morning-scan',
      generationSource: 'cron:first-morning-scan',
    }),
  );
}

/** 09:45 IST — main morning DB-only scan. */
export function runMainMorningScanJob(): Promise<DailyScanJobResult> {
  return guardJob('main-morning-scan', () =>
    runDbScanJob({
      jobName: 'main-morning-scan',
      generationSource: 'cron:main-morning-scan',
    }),
  );
}

/** 12:30 IST — rescore active signals only. */
export function runMiddayRescoreJob(): Promise<DailyScanJobResult> {
  return guardJob('midday-rescore', () =>
    runRescoreJob({
      jobName: 'midday-rescore',
      generationSource: 'cron:midday-rescore',
    }),
  );
}

/** 14:45 IST — late-day rescore / light confirmation. */
export function runLateRescoreJob(): Promise<DailyScanJobResult> {
  return guardJob('late-rescore', () =>
    runRescoreJob({
      jobName: 'late-rescore',
      generationSource: 'cron:late-rescore',
    }),
  );
}

/** @deprecated alias — use runFirstMorningScanJob */
export function runMorningScanJob(): Promise<DailyScanJobResult> {
  return runFirstMorningScanJob();
}

/** Evening Update — 16:00 IST, incremental IndianAPI EOD candle fetch. */
export function runEveningUpdateJob(): Promise<DailyScanJobResult> {
  return guardJob('evening-update', executeEveningUpdateJob);
}

/** Evening Scan — 16:30 IST, DB-only post-update EOD signals. */
export function runEveningScanJob(): Promise<DailyScanJobResult> {
  return guardJob('evening-scan', () =>
    runDbScanJob({
      jobName: 'evening-scan',
      generationSource: 'cron:evening-scan',
    }),
  );
}

/** Optional legacy 18:30 IST scan (off by default). */
export function runLegacyEveningScanJob(): Promise<DailyScanJobResult> {
  return guardJob('legacy-evening-scan-1830', () =>
    runDbScanJob({
      jobName: 'legacy-evening-scan-1830',
      generationSource: 'cron:signal-generation',
    }),
  );
}

/** Manipulation Scan — 18:30 IST, scan-only (EOD candles refreshed at 16:00).
 *
 * Calls runDailyScan({ skipIngestion: true }) so this job NEVER invokes
 * runDailyEodIngestion — duplicate ingestion is owned exclusively by the
 * 16:00 Evening Update (`runEveningUpdateJob`). The scanner reads whatever
 * `candles` rows landed during that update.
 */
export function runManipulationDailyScanJob(): Promise<DailyScanResult> {
  if (manipulationDailyScanInFlight) {
    log.warn('manipulation daily scan skipped — previous run still in flight');
    return manipulationDailyScanInFlight;
  }

  console.log('[manipulation] daily scan started');
  log.info('[manipulation] daily scan started');

  const promise = runDailyScan({ skipIngestion: true })
    .then((result) => {
      if (result.ok) {
        console.log('[manipulation] daily scan complete', {
          scanned: result.scan.scanned,
          snapshotsPersisted: result.scan.snapshotsPersisted,
          failed: result.scan.failed,
          durationMs: result.scan.durationMs,
        });
        log.info('[manipulation] daily scan complete', {
          scanned:            result.scan.scanned,
          snapshotsPersisted: result.scan.snapshotsPersisted,
          failed:             result.scan.failed,
          penaltiesWritten:   result.scan.penaltiesWritten,
          durationMs:         result.scan.durationMs,
          latestEventDate:    result.latestEventDate,
        });
      } else {
        console.error('[manipulation] daily scan failed', {
          reason: result.reason,
          warnings: result.warnings,
        });
        log.error('[manipulation] daily scan failed', {
          reason:   result.reason,
          warnings: result.warnings,
          scan:     result.scan,
        });
      }
      return result;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[manipulation] daily scan failed', { error: msg });
      log.error('[manipulation] daily scan failed', { err: msg });
      throw err;
    })
    .finally(() => {
      manipulationDailyScanInFlight = null;
    });

  manipulationDailyScanInFlight = promise;
  return promise;
}

export function startDailyScanSchedule(): void {
  if (!envEnabled('DAILY_SCAN_SCHEDULE_ENABLED', true)) {
    log.info('daily scan schedule disabled (DAILY_SCAN_SCHEDULE_ENABLED=false)');
    return;
  }
  if (tasks.length > 0) {
    log.warn('daily scan schedule already started — ignoring duplicate start');
    return;
  }

  const crons = resolveControlledSignalCrons();
  const manipulationDailyScanCron = envCron(
    'MANIPULATION_DAILY_SCAN_CRON',
    DAILY_SCHEDULE_CRONS.manipulationDailyScan,
  );
  const legacy1830Cron = envCron('SIGNAL_LEGACY_EVENING_SCAN_CRON', DAILY_SCHEDULE_CRONS.manipulationDailyScan);

  if (!isManipulationScheduledAfterEodUpdate({
    eveningUpdate: crons.eveningUpdate,
    eveningScan: crons.eveningScan,
    manipulationDailyScan: manipulationDailyScanCron,
  })) {
    log.warn('manipulation daily scan cron is not after evening EOD update', {
      evening_update: crons.eveningUpdate,
      evening_scan: crons.eveningScan,
      manipulation_daily_scan: manipulationDailyScanCron,
    });
  }

  tasks.push(cron.schedule(crons.readinessCheck, () => {
    void runReadinessCheckJob().catch((err) => {
      log.error('readiness check failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.firstMorningScan, () => {
    void runFirstMorningScanJob().catch((err) => {
      log.error('first morning scan failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.mainMorningScan, () => {
    void runMainMorningScanJob().catch((err) => {
      log.error('main morning scan failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.middayRescore, () => {
    void runMiddayRescoreJob().catch((err) => {
      log.error('midday rescore failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.lateRescore, () => {
    void runLateRescoreJob().catch((err) => {
      log.error('late rescore failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.eveningUpdate, () => {
    void runEveningUpdateJob().catch((err) => {
      log.error('evening update failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(crons.eveningScan, () => {
    void runEveningScanJob().catch((err) => {
      log.error('evening scan failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(manipulationDailyScanCron, () => {
    void runManipulationDailyScanJob().catch((err) => {
      log.error('manipulation daily scan cron failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  if (envEnabled('SIGNAL_LEGACY_EVENING_SCAN_1830', false)) {
    tasks.push(cron.schedule(legacy1830Cron, () => {
      void runLegacyEveningScanJob().catch((err) => {
        log.error('legacy 18:30 evening scan failed', { err: String(err) });
      });
    }, { timezone: DAILY_SCAN_TIMEZONE }));
  }

  log.info('daily scan schedule started', {
    timezone: DAILY_SCAN_TIMEZONE,
    readiness_check: crons.readinessCheck,
    first_morning_scan: crons.firstMorningScan,
    main_morning_scan: crons.mainMorningScan,
    midday_rescore: crons.middayRescore,
    late_rescore: crons.lateRescore,
    evening_update: crons.eveningUpdate,
    evening_scan: crons.eveningScan,
    manipulation_daily_scan: manipulationDailyScanCron,
    legacy_1830: envEnabled('SIGNAL_LEGACY_EVENING_SCAN_1830', false) ? legacy1830Cron : 'disabled',
    jobs: tasks.length,
  });
}

export function stopDailyScanSchedule(): void {
  for (const t of tasks) t.stop();
  tasks.length = 0;
  log.info('daily scan schedule stopped');
}
