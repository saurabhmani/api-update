import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';
import { findMaintenanceDatesToRun, runScheduledMaintenance } from './scheduler';
import type { OrchestrationResult } from './orchestrator';

const log = logger.child({ component: 'maintenance-boot-catchup' });

export interface BootCatchUpOptions {
  reason?:               string;
  lookbackTradingDays?:  number;
  maxDates?:             number;
}

async function isMaintenanceComplete(tradingDate: string): Promise<boolean> {
  const { rows } = await db.query<any>(
    `SELECT status FROM q365_maintenance_job_runs
      WHERE job_name='health_snapshot' AND trading_date=? AND job_version='v1'
      LIMIT 1`,
    [tradingDate],
  ).catch(() => ({ rows: [] }));
  return rows[0]?.status === 'succeeded';
}

/**
 * Bounded, idempotent startup catch-up for missed maintenance windows.
 * Uses q365_maintenance_job_runs as source of truth — concurrent invocations
 * coalesce through the existing DB claim mechanism in the orchestrator.
 */
export async function runMaintenanceBootCatchUp(
  options: BootCatchUpOptions = {},
): Promise<OrchestrationResult[]> {
  const reason = options.reason ?? 'boot';
  const lookback = options.lookbackTradingDays ?? 7;
  const maxDates = options.maxDates ?? 2;
  const expectedAnchor = getLatestCompletedTradingDay();

  log.info('maintenance catch-up: starting', {
    reason,
    expectedAnchor,
    lookbackTradingDays: lookback,
    maxDates,
  });

  const pending = await findMaintenanceDatesToRun({ lookbackTradingDays: lookback, maxDates });
  const pendingSet = new Set(pending);

  // Log every candidate in lookback window for operator visibility.
  const { rows } = await db.query<any>(
    `SELECT DISTINCT trading_date FROM q365_maintenance_job_runs
      WHERE trading_date >= DATE_SUB(?, INTERVAL ? DAY)`,
    [expectedAnchor, lookback + 2],
  ).catch(() => ({ rows: [] }));
  const seenDates = new Set<string>(pending);
  for (const row of rows) {
    seenDates.add(String(row.trading_date).slice(0, 10));
  }
  for (const date of pending) seenDates.add(date);

  for (const date of [...seenDates].sort()) {
    const complete = await isMaintenanceComplete(date);
    if (complete) {
      log.info(`maintenance catch-up: expected_date=${date} status=already_completed action=skip`);
    } else if (pendingSet.has(date)) {
      log.info(`maintenance catch-up: expected_date=${date} status=missing action=run`);
    }
  }

  if (pending.length === 0) {
    log.info('maintenance catch-up: no missing trading dates', { reason, expectedAnchor });
    return [];
  }

  const results = await runScheduledMaintenance({ lookbackTradingDays: lookback, maxDates });
  log.info('maintenance catch-up: complete', {
    reason,
    datesAttempted: pending,
    outcomes: results.map((r) => ({ tradingDate: r.tradingDate, status: r.status })),
  });
  return results;
}
