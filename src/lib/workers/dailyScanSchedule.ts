// ════════════════════════════════════════════════════════════════
//  Daily scan schedule — morning DB scan, evening candle update,
//  evening DB scan (IST, Mon–Fri).
//
//  Morning Scan      08:30 IST  mode=scan               DB only
//  Evening Update    16:00 IST  mode=incremental-update IndianAPI
//  Evening Scan      16:30 IST  mode=scan               DB only
//
//  Cron overrides (env):
//    MORNING_SCAN_CRON=30 8 * * 1-5
//    EVENING_UPDATE_CRON=0 16 * * 1-5
//    EVENING_SCAN_CRON=30 16 * * 1-5
//    DAILY_SCAN_SCHEDULE_ENABLED=true|false
//    SIGNAL_LEGACY_EVENING_SCAN_1830=true  — optional 18:30 duplicate scan
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

const log = logger.child({ component: 'dailyScanSchedule' });
export const DAILY_SCAN_TIMEZONE = 'Asia/Kolkata';

export type DailyJobMode = 'scan' | 'incremental-update';
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

function envCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

function envEnabled(name: string, defaultOn = true): boolean {
  const raw = (process.env[name] ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
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

/** Morning Scan — 08:30 IST, DB-only pre-market signals. */
export function runMorningScanJob(): Promise<DailyScanJobResult> {
  return guardJob('morning-scan', () =>
    runDbScanJob({
      jobName: 'morning-scan',
      generationSource: 'cron:morning-scan',
    }),
  );
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

export function startDailyScanSchedule(): void {
  if (!envEnabled('DAILY_SCAN_SCHEDULE_ENABLED', true)) {
    log.info('daily scan schedule disabled (DAILY_SCAN_SCHEDULE_ENABLED=false)');
    return;
  }
  if (tasks.length > 0) {
    log.warn('daily scan schedule already started — ignoring duplicate start');
    return;
  }

  const morningCron = envCron('MORNING_SCAN_CRON', '30 8 * * 1-5');
  const eveningUpdateCron = envCron(
    'EVENING_UPDATE_CRON',
    process.env.CANDLE_DAILY_UPDATE_CRON?.trim() || '0 16 * * 1-5',
  );
  const eveningScanCron = envCron('EVENING_SCAN_CRON', '30 16 * * 1-5');
  const legacy1830Cron = envCron('SIGNAL_LEGACY_EVENING_SCAN_CRON', '30 18 * * 1-5');

  tasks.push(cron.schedule(morningCron, () => {
    void runMorningScanJob().catch((err) => {
      log.error('morning scan failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(eveningUpdateCron, () => {
    void runEveningUpdateJob().catch((err) => {
      log.error('evening update failed', { err: String(err) });
    });
  }, { timezone: DAILY_SCAN_TIMEZONE }));

  tasks.push(cron.schedule(eveningScanCron, () => {
    void runEveningScanJob().catch((err) => {
      log.error('evening scan failed', { err: String(err) });
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
    morning_scan: morningCron,
    evening_update: eveningUpdateCron,
    evening_scan: eveningScanCron,
    legacy_1830: envEnabled('SIGNAL_LEGACY_EVENING_SCAN_1830', false) ? legacy1830Cron : 'disabled',
    jobs: tasks.length,
  });
}

export function stopDailyScanSchedule(): void {
  for (const t of tasks) t.stop();
  tasks.length = 0;
  log.info('daily scan schedule stopped');
}
