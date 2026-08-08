/**
 * Central trading-data freshness service (API fallback).
 *
 * Scheduler remains primary for evening candle update + scans.
 * This module is a self-heal path when an API reader finds stale
 * warehouse / missing session scan.
 *
 * Design:
 *   API hit → probe session freshness → if stale, lock + refresh once
 *   → never full-universe refetch on every request
 *   → never force maturity / APPROVED promotions
 */

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  getLatestCompletedTradingDay,
  getMarketStatus,
  isMarketOpen,
} from '@/lib/marketData/marketHours';
import {
  cacheAcquireLock,
  cacheReleaseLock,
} from '@/lib/redis';

const log = logger.child({ component: 'tradingDataFreshness' });

const CANDLE_LOCK = 'q365:freshness:candle-update';
const SCAN_LOCK = 'q365:freshness:session-scan';
const CANDLE_LOCK_TTL_S = 15 * 60;
const SCAN_LOCK_TTL_S = 20 * 60;

/** In-process coalescing when Redis is down. */
const localInflight = new Map<string, Promise<unknown>>();

export type FreshnessAction =
  | 'already_fresh'
  | 'candles_refreshed'
  | 'candles_refresh_in_progress'
  | 'candles_refresh_skipped_session_incomplete'
  | 'candles_refresh_skipped_market_closed'
  | 'scan_triggered'
  | 'scan_in_progress'
  | 'scan_skipped_candles_stale'
  | 'scan_skipped_market_closed'
  | 'failed'
  | 'disabled';

export interface TradingSessionFreshness {
  expectedTradingDay: string;
  marketOpen: boolean;
  marketState: string;
  latestCandleDay: string | null;
  latestIndianApiCandleDay: string | null;
  latestBhavcopyCandleDay: string | null;
  universeActive: number;
  symbolsOnExpectedDay: number;
  coveragePct: number;
  candlesFresh: boolean;
  latestScheduledScanAt: string | null;
  latestSignalAt: string | null;
  scanFresh: boolean;
}

export interface EnsureTradingDataFreshResult {
  session: TradingSessionFreshness;
  candleAction: FreshnessAction;
  scanAction: FreshnessAction;
  error?: string;
}

const SCHEDULED_SCAN_SOURCES = [
  'cron:first-morning-scan',
  'cron:main-morning-scan',
  'cron:evening-scan',
  'cron:morning-scan',
  'cron:signal-generation',
  'api:freshness:session-scan',
];

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = (process.env[name] ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function coverageFloor(): number {
  const n = Number(process.env.API_FRESHNESS_CANDLE_COVERAGE_PCT);
  return Number.isFinite(n) && n > 0 ? Math.min(95, Math.max(10, n)) : 40;
}

function repairMaxFetch(): number {
  const n = Number(process.env.API_FRESHNESS_CANDLE_MAX_FETCH);
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(10, Math.floor(n))) : 80;
}

function istDayExpr(col: string): string {
  // Prefer CONVERT_TZ; fall back to DATE(col) if timezone tables missing.
  return `DATE(CONVERT_TZ(${col}, '+00:00', '+05:30'))`;
}

async function querySessionFreshness(): Promise<TradingSessionFreshness> {
  const expectedTradingDay = getLatestCompletedTradingDay();
  const market = getMarketStatus();

  const { rows: uniRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_universe WHERE is_active = 1`,
  );
  const universeActive = Number(uniRows[0]?.c ?? 0);

  const { rows: mdd } = await db.query<{
    latest: Date | string | null;
    on_day: number;
  }>(
    `SELECT MAX(${istDayExpr('ts')}) AS latest,
            SUM(CASE WHEN ${istDayExpr('ts')} = ? THEN 1 ELSE 0 END) AS on_day
       FROM market_data_daily`,
    [expectedTradingDay],
  ).catch(async () => {
    const { rows } = await db.query<{
      latest: Date | string | null;
      on_day: number;
    }>(
      `SELECT MAX(DATE(ts)) AS latest,
              SUM(CASE WHEN DATE(ts) = ? THEN 1 ELSE 0 END) AS on_day
         FROM market_data_daily`,
      [expectedTradingDay],
    );
    return { rows };
  });

  const latestCandleDay = mdd[0]?.latest
    ? String(mdd[0].latest).slice(0, 10)
    : null;
  const symbolsOnExpectedDay = Number(mdd[0]?.on_day ?? 0);
  const coveragePct =
    universeActive > 0
      ? Math.round((symbolsOnExpectedDay / universeActive) * 1000) / 10
      : 0;

  let latestIndianApiCandleDay: string | null = null;
  let latestBhavcopyCandleDay: string | null = null;
  try {
    const { rows: bySrc } = await db.query<{ source: string | null; mx: Date | string | null }>(
      `SELECT source, MAX(${istDayExpr('ts')}) AS mx
         FROM candles
        WHERE candle_type = 'eod'
        GROUP BY source`,
    );
    for (const r of bySrc) {
      const day = r.mx ? String(r.mx).slice(0, 10) : null;
      if (r.source === 'indianapi') latestIndianApiCandleDay = day;
      if (r.source === 'nse_bhavcopy') latestBhavcopyCandleDay = day;
    }
  } catch {
    /* optional diagnostics */
  }

  const { rows: scanRows } = await db.query<{ mx: Date | string | null }>(
    `SELECT MAX(created_at) AS mx
       FROM q365_signals
      WHERE generation_source IN (${SCHEDULED_SCAN_SOURCES.map(() => '?').join(',')})
        AND ${istDayExpr('created_at')} >= ?`,
    [...SCHEDULED_SCAN_SOURCES, expectedTradingDay],
  ).catch(async () => {
    const { rows } = await db.query<{ mx: Date | string | null }>(
      `SELECT MAX(created_at) AS mx
         FROM q365_signals
        WHERE generation_source IN (${SCHEDULED_SCAN_SOURCES.map(() => '?').join(',')})
          AND DATE(created_at) >= ?`,
      [...SCHEDULED_SCAN_SOURCES, expectedTradingDay],
    );
    return { rows };
  });

  const latestScheduledScanAt = scanRows[0]?.mx
    ? new Date(scanRows[0].mx as Date | string).toISOString()
    : null;

  const { rows: anySig } = await db.query<{ mx: Date | string | null }>(
    `SELECT MAX(created_at) AS mx FROM q365_signals`,
  );
  const latestSignalAt = anySig[0]?.mx
    ? new Date(anySig[0].mx as Date | string).toISOString()
    : null;

  const candlesFresh =
    latestCandleDay === expectedTradingDay && coveragePct >= coverageFloor();

  // Scan is fresh if we have a controlled-source write on/after expected day.
  // During open market, morning scan for *prior* completed day is enough
  // until evening update lands today's EOD.
  const scanFresh = Boolean(latestScheduledScanAt) && candlesFresh;

  return {
    expectedTradingDay,
    marketOpen: market.isOpen,
    marketState: market.state,
    latestCandleDay,
    latestIndianApiCandleDay,
    latestBhavcopyCandleDay,
    universeActive,
    symbolsOnExpectedDay,
    coveragePct,
    candlesFresh,
    latestScheduledScanAt,
    latestSignalAt,
    scanFresh,
  };
}

export async function getTradingSessionFreshness(): Promise<TradingSessionFreshness> {
  return probeSessionFreshnessBounded(2_500);
}

async function withLock<T>(
  lockKey: string,
  ttlS: number,
  work: () => Promise<T>,
): Promise<{ status: 'ran' | 'held' | 'failed'; result?: T; error?: string }> {
  const token = randomUUID();
  const acquired = await cacheAcquireLock(lockKey, token, ttlS);
  if (!acquired) {
    return { status: 'held' };
  }

  const existing = localInflight.get(lockKey);
  if (existing) {
    try {
      await existing;
    } catch {
      /* ignore */
    }
    await cacheReleaseLock(lockKey, token);
    return { status: 'held' };
  }

  const promise = (async () => {
    try {
      return await work();
    } finally {
      localInflight.delete(lockKey);
      await cacheReleaseLock(lockKey, token);
    }
  })();
  localInflight.set(lockKey, promise);

  try {
    const result = (await promise) as T;
    return { status: 'ran', result };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runBoundedCandleRepair(_expectedDay: string): Promise<void> {
  const { runCandleDailyUpdateJob } = await import(
    '@/lib/marketData/candleDailyUpdateJob'
  );
  // Bounded maxFetch — not a full-universe IndianAPI sweep on every API hit.
  // Job already skips symbols whose latest candle >= completed trading day.
  await runCandleDailyUpdateJob({
    maxFetch: repairMaxFetch(),
  });
}

async function runSessionScanOnce(): Promise<void> {
  const { runEveningScanJob, runFirstMorningScanJob } = await import(
    '@/lib/workers/dailyScanSchedule'
  );
  // Prefer evening scan after EOD; morning scan otherwise.
  const market = getMarketStatus();
  if (market.state === 'closed' || market.state === 'holiday') {
    await runEveningScanJob();
  } else {
    await runFirstMorningScanJob();
  }
}

export interface EnsureTradingDataFreshOptions {
  /** When true, may trigger a bounded candle repair if stale. Default true. */
  refreshCandles?: boolean;
  /** When true, may trigger one DB-only scan if candles fresh but scan missing. */
  refreshScan?: boolean;
  /**
   * When true, await repair/scan (bootstrap). Default false — fire-and-forget
   * so /api/signals polls stay fast.
   */
  awaitWork?: boolean;
  /** Max wait when awaitWork (ms). */
  maxWaitMs?: number;
}

/**
 * Probe + optional self-heal. Safe for concurrent API hits (Redis/mem lock).
 * Does NOT promote confirmed snapshots / APPROVED rows.
 *
 * IMPORTANT: background candle/scan repair is ONLY allowed when the
 * market is open, or when the caller explicitly awaits work (bootstrap).
 * Off-hours fire-and-forget from /api/signals + /api/ticker polls was
 * saturating MySQL/IndianAPI and producing production 504s.
 */
export async function ensureTradingDataFresh(
  opts: EnsureTradingDataFreshOptions = {},
): Promise<EnsureTradingDataFreshResult> {
  if (!envFlag('API_FRESHNESS_FALLBACK_ENABLED', true)) {
    const session = await probeSessionFreshnessBounded();
    return {
      session,
      candleAction: 'disabled',
      scanAction: 'disabled',
    };
  }

  const refreshCandles = opts.refreshCandles !== false;
  const refreshScan = opts.refreshScan !== false;
  const awaitWork = opts.awaitWork === true;
  const maxWaitMs = Math.max(1_000, Math.min(120_000, opts.maxWaitMs ?? 8_000));
  const marketOpen = isMarketOpen();
  // Scheduler owns closed-market / weekend repair. API polls must not
  // spawn full candle jobs or evening scans in the background.
  const allowBgRepair = awaitWork || marketOpen;

  let session = await probeSessionFreshnessBounded();
  let candleAction: FreshnessAction = session.candlesFresh
    ? 'already_fresh'
    : 'failed';
  let scanAction: FreshnessAction = session.scanFresh
    ? 'already_fresh'
    : 'failed';
  let error: string | undefined;

  // Before session close, do not demand today's EOD candle.
  if (!session.candlesFresh && marketOpen) {
    candleAction = 'candles_refresh_skipped_session_incomplete';
    // Treat prior completed day as the bar for scan freshness mid-session.
    scanAction = session.latestScheduledScanAt ? 'already_fresh' : scanAction;
  }

  if (!session.candlesFresh && !marketOpen && !awaitWork) {
    candleAction = 'candles_refresh_skipped_market_closed';
  }

  if (
    refreshCandles &&
    !session.candlesFresh &&
    candleAction !== 'candles_refresh_skipped_session_incomplete' &&
    candleAction !== 'candles_refresh_skipped_market_closed' &&
    allowBgRepair
  ) {
    const work = async () => {
      log.info('API freshness candle repair starting', {
        expectedTradingDay: session.expectedTradingDay,
        coveragePct: session.coveragePct,
        maxFetch: repairMaxFetch(),
        awaitWork,
        marketOpen,
      });
      await runBoundedCandleRepair(session.expectedTradingDay);
    };

    if (awaitWork) {
      const raced = Promise.race([
        withLock(CANDLE_LOCK, CANDLE_LOCK_TTL_S, work),
        new Promise<{ status: 'held' }>((resolve) =>
          setTimeout(() => resolve({ status: 'held' }), maxWaitMs),
        ),
      ]);
      const outcome = await raced;
      if (outcome.status === 'ran') candleAction = 'candles_refreshed';
      else if (outcome.status === 'held') candleAction = 'candles_refresh_in_progress';
      else {
        candleAction = 'failed';
        error = 'error' in outcome ? outcome.error : 'candle_refresh_failed';
      }
      session = await probeSessionFreshnessBounded();
      if (session.candlesFresh) candleAction = 'candles_refreshed';
    } else {
      // Fire-and-forget under lock — do NOT re-probe (avoids doubling
      // DB load on every poll while a repair may already be running).
      void withLock(CANDLE_LOCK, CANDLE_LOCK_TTL_S, work).then((o) => {
        if (o.status === 'failed') {
          log.warn('background candle freshness repair failed', { error: o.error });
        }
      });
      candleAction = 'candles_refresh_in_progress';
    }
  } else if (session.candlesFresh) {
    candleAction = 'already_fresh';
  }

  if (!allowBgRepair && refreshScan && !session.scanFresh) {
    scanAction = 'scan_skipped_market_closed';
  } else if (refreshScan && !session.scanFresh) {
    if (
      !session.candlesFresh
      && candleAction !== 'candles_refresh_skipped_session_incomplete'
      && candleAction !== 'candles_refresh_skipped_market_closed'
    ) {
      scanAction = 'scan_skipped_candles_stale';
    } else if (
      candleAction === 'candles_refresh_skipped_session_incomplete' &&
      session.latestScheduledScanAt
    ) {
      scanAction = 'already_fresh';
    } else if (allowBgRepair) {
      const work = async () => {
        log.info('API freshness session scan starting', {
          expectedTradingDay: session.expectedTradingDay,
          awaitWork,
          marketOpen,
        });
        await runSessionScanOnce();
      };

      if (awaitWork) {
        const raced = Promise.race([
          withLock(SCAN_LOCK, SCAN_LOCK_TTL_S, work),
          new Promise<{ status: 'held' }>((resolve) =>
            setTimeout(() => resolve({ status: 'held' }), maxWaitMs),
          ),
        ]);
        const outcome = await raced;
        if (outcome.status === 'ran') scanAction = 'scan_triggered';
        else if (outcome.status === 'held') scanAction = 'scan_in_progress';
        else {
          scanAction = 'failed';
          error = ('error' in outcome ? outcome.error : undefined) ?? error ?? 'scan_failed';
        }
        session = await probeSessionFreshnessBounded();
      } else {
        void withLock(SCAN_LOCK, SCAN_LOCK_TTL_S, work).then((o) => {
          if (o.status === 'failed') {
            log.warn('background session scan failed', { error: o.error });
          }
        });
        scanAction = 'scan_triggered';
      }
    }
  } else if (session.scanFresh) {
    scanAction = 'already_fresh';
  }

  return { session, candleAction, scanAction, error };
}

async function probeSessionFreshnessBounded(
  timeoutMs = 2_500,
): Promise<TradingSessionFreshness> {
  try {
    const result = await Promise.race([
      querySessionFreshness(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (result) return result;
  } catch (err) {
    log.warn('session freshness probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const market = getMarketStatus();
  const expectedTradingDay = getLatestCompletedTradingDay();
  return {
    expectedTradingDay,
    marketOpen: market.isOpen,
    marketState: market.state,
    latestCandleDay: null,
    latestIndianApiCandleDay: null,
    latestBhavcopyCandleDay: null,
    universeActive: 0,
    symbolsOnExpectedDay: 0,
    coveragePct: 0,
    candlesFresh: false,
    latestScheduledScanAt: null,
    latestSignalAt: null,
    scanFresh: false,
  };
}

/** Alias helpers for call sites / docs. */
export async function ensureMarketDataFresh(
  opts?: EnsureTradingDataFreshOptions,
): Promise<EnsureTradingDataFreshResult> {
  return ensureTradingDataFresh({ ...opts, refreshScan: false });
}

export async function ensureSignalsFresh(
  opts?: EnsureTradingDataFreshOptions,
): Promise<EnsureTradingDataFreshResult> {
  return ensureTradingDataFresh(opts);
}
