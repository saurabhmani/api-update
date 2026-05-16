// ════════════════════════════════════════════════════════════════
//  Daily Manipulation Scan — composed pipeline.
//
//  Sequence:
//    1. runDailyEodIngestion(date)
//         Refreshes the `candles` warehouse from free EOD sources.
//    2. Verify the latest candle date actually advanced.
//    3. runManipulationScan(...)
//         Walks the Phase-1 universe, generates snapshots / events /
//         penalties against the freshly-ingested candles.
//
//  If step 1 produces no new candles (every source FAILED), step 3
//  is still executed against whatever is already in the warehouse —
//  matching the existing manual "Run Full Scan" behaviour — but the
//  response carries a stale=true flag so the caller knows the scan
//  ran against historical data.
//
//  This is the function the scheduler cron and the new
//  /api/manipulation/daily-scan route both call. It never throws —
//  failure is reported via the structured `DailyScanResult` envelope.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  runDailyEodIngestion,
  type RunEodIngestionOptions,
} from '@/lib/marketData/eod/eodIngestionPipeline';
import { runManipulationScan } from '@/lib/workers/manipulationScanner';
import type { EodIngestionResult } from '@/lib/marketData/eod/types';

const log = logger.child({ component: 'manipulation-daily-scan' });

export interface RunDailyScanOptions {
  /** Target trade date for the EOD pull. */
  date?:           string;
  /** Per-adapter timeout. */
  timeoutMs?:      number;
  /** Universe override for the scanner. */
  universe?:       string[];
  /** Caps universe size — useful for ad-hoc tests. */
  limit?:          number;
  /** Skip the scanner step (ingestion only). */
  skipScan?:       boolean;
  /** Skip the ingestion step (scan only — legacy path). */
  skipIngestion?:  boolean;
  /** Skip the retroactive-penalty backfill inside the scanner. */
  skipPenalties?:  boolean;
}

export interface DailyScanResult {
  ok:              boolean;
  startedAt:       string;
  completedAt:     string;
  /** Was the candle warehouse advanced by this run? */
  candlesAdvanced: boolean;
  /** Candle freshness pre-ingestion. */
  candleDateBefore: string | null;
  /** Candle freshness post-ingestion. */
  candleDateAfter:  string | null;
  /** EOD ingestion summary (one entry per adapter). */
  ingestion:        EodIngestionResult | null;
  /** Manipulation scan summary. */
  scan: {
    skipped:             boolean;
    scanned:             number;
    snapshotsPersisted:  number;
    skippedInsufficient: number;
    failed:              number;
    bandCounts:          { low: number; watch: number; elevated: number; high: number; severe: number };
    penaltiesWritten:    number;
    durationMs:          number;
  };
  /** Latest manipulation event date after the scan completed. */
  latestEventDate: string | null;
  /** Human-readable explanation. */
  reason:          string;
  warnings:        string[];
}

async function readLatestCandleDate(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(ts) AS d FROM candles WHERE candle_type='eod' AND interval_unit='1day'`,
    );
    const d = rows?.[0]?.d;
    if (!d) return null;
    return typeof d === 'string' ? d.split('T')[0] : new Date(d).toISOString().split('T')[0];
  } catch {
    return null;
  }
}

async function readLatestEventDate(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(event_date) AS d FROM q365_manipulation_events`,
    );
    const d = rows?.[0]?.d;
    if (!d) return null;
    return typeof d === 'string' ? d.split('T')[0] : new Date(d).toISOString().split('T')[0];
  } catch {
    return null;
  }
}

export async function runDailyManipulationScan(
  options: RunDailyScanOptions = {},
): Promise<DailyScanResult> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];

  log.info('daily manipulation pipeline starting', {
    date:          options.date ?? '(today)',
    skipIngestion: !!options.skipIngestion,
    skipScan:      !!options.skipScan,
  });

  const candleDateBefore = await readLatestCandleDate();

  // ── 1. EOD ingestion ──────────────────────────────────────────
  let ingestion: EodIngestionResult | null = null;
  if (!options.skipIngestion) {
    const ingestOpts: RunEodIngestionOptions = {
      date:      options.date,
      timeoutMs: options.timeoutMs,
    };
    try {
      ingestion = await runDailyEodIngestion(ingestOpts);
      warnings.push(...ingestion.warnings);
    } catch (err) {
      warnings.push(`EOD ingestion threw unexpectedly: ${(err as Error).message}`);
      log.error('eod ingestion threw', { err: (err as Error).message });
    }
  } else {
    warnings.push('EOD ingestion skipped by caller — scan running against existing candle warehouse.');
  }

  const candleDateAfter = await readLatestCandleDate();
  const candlesAdvanced =
    candleDateAfter != null &&
    (candleDateBefore == null || candleDateAfter > candleDateBefore);

  // ── 2. Manipulation scan ──────────────────────────────────────
  // Even when ingestion fails, we still attempt the scanner so the
  // operator's "Run Daily Scan" button has predictable behaviour
  // (scan against whatever candles we have). The response's
  // `candlesAdvanced` flag tells the caller whether the scan is
  // operating on fresh or stale data.
  let scan: DailyScanResult['scan'] = {
    skipped:             true,
    scanned:             0,
    snapshotsPersisted:  0,
    skippedInsufficient: 0,
    failed:              0,
    bandCounts:          { low: 0, watch: 0, elevated: 0, high: 0, severe: 0 },
    penaltiesWritten:    0,
    durationMs:          0,
  };

  if (!options.skipScan) {
    try {
      const r = await runManipulationScan({
        universe:      options.universe,
        skipPenalties: options.skipPenalties,
        limit:         options.limit,
      });
      scan = {
        skipped:             false,
        scanned:             r.scanned,
        snapshotsPersisted:  r.snapshotsPersisted,
        skippedInsufficient: r.skippedInsufficient,
        failed:              r.failed,
        bandCounts:          r.bandCounts,
        penaltiesWritten:    r.penaltiesWritten,
        durationMs:          r.durationMs,
      };
    } catch (err) {
      warnings.push(`Manipulation scan threw unexpectedly: ${(err as Error).message}`);
      log.error('manipulation scan threw', { err: (err as Error).message });
    }
  } else {
    warnings.push('Scanner step skipped by caller — ingestion-only run.');
  }

  const latestEventDate = await readLatestEventDate();

  // ── 3. Build human-readable explanation. ──────────────────────
  let reason: string;
  if (!options.skipIngestion && candlesAdvanced && scan.snapshotsPersisted > 0) {
    reason =
      `EOD candles advanced ${candleDateBefore ?? 'never'} → ${candleDateAfter}. ` +
      `Scanned ${scan.scanned} symbols, persisted ${scan.snapshotsPersisted} snapshots, ` +
      `wrote ${scan.penaltiesWritten} retroactive penalties.`;
  } else if (!options.skipIngestion && !candlesAdvanced) {
    reason =
      `Candle warehouse did not advance (still ${candleDateAfter ?? 'empty'}). ` +
      `Scanner ran against existing data — Signal Engine will stay warning-only for manipulation until candles refresh.`;
  } else if (options.skipScan && !options.skipIngestion) {
    reason =
      `Ingestion-only run. Candles ${candleDateBefore ?? 'empty'} → ${candleDateAfter ?? 'empty'}. ` +
      `Manipulation scan not requested.`;
  } else {
    reason =
      scan.snapshotsPersisted > 0
        ? `Scanner ran without ingestion. Persisted ${scan.snapshotsPersisted} snapshots.`
        : 'Daily pipeline produced no new data — see warnings for per-step status.';
  }

  const ok =
    (options.skipIngestion || (ingestion?.ok ?? false)) &&
    (options.skipScan      || scan.snapshotsPersisted > 0 || scan.scanned > 0);

  const completedAt = new Date().toISOString();
  log.info('daily manipulation pipeline complete', {
    ok,
    candlesAdvanced,
    candleDateBefore,
    candleDateAfter,
    latestEventDate,
    scanned:            scan.scanned,
    snapshotsPersisted: scan.snapshotsPersisted,
    elapsedMs:          new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  });

  return {
    ok,
    startedAt,
    completedAt,
    candlesAdvanced,
    candleDateBefore,
    candleDateAfter,
    ingestion,
    scan,
    latestEventDate,
    reason,
    warnings,
  };
}
