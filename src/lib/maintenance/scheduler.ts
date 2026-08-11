import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getLatestCompletedTradingDay, getMarketStatus } from '@/lib/marketData/marketHours';
import { maintenanceJobRunStore } from './jobRunRepository';
import { runMaintenanceForDate, type OrchestrationResult } from './orchestrator';
import { createProductionMaintenanceStages } from './productionStages';

const log = logger.child({ component: 'maintenance-scheduler' });

function previousWeekdays(endDate: string, count: number): string[] {
  const date = new Date(`${endDate}T12:00:00.000Z`);
  const dates: string[] = [];
  while (dates.length < count) {
    const day = date.getUTCDay();
    const dateString = date.toISOString().slice(0, 10);
    const marketDay = getMarketStatus(new Date(`${dateString}T06:00:00.000Z`));
    if (day !== 0 && day !== 6 && marketDay.state !== 'holiday') dates.push(dateString);
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return dates.reverse();
}

export async function findMaintenanceDatesToRun(options: { lookbackTradingDays?: number; maxDates?: number } = {}) {
  const candidates = previousWeekdays(getLatestCompletedTradingDay(), options.lookbackTradingDays ?? 7);
  const { rows } = await db.query<any>(
    `SELECT trading_date FROM q365_maintenance_job_runs
      WHERE job_name='health_snapshot' AND status='succeeded'
        AND trading_date BETWEEN ? AND ?`,
    [candidates[0], candidates[candidates.length - 1]],
  ).catch(() => ({ rows: [] }));
  const completed = new Set(rows.map((row: any) => String(row.trading_date).slice(0, 10)));
  return candidates.filter((date) => !completed.has(date)).slice(0, options.maxDates ?? 2);
}

export async function runScheduledMaintenance(options: { lookbackTradingDays?: number; maxDates?: number } = {}): Promise<OrchestrationResult[]> {
  const dates = await findMaintenanceDatesToRun(options);
  const results: OrchestrationResult[] = [];
  for (const tradingDate of dates) {
    const result = await runMaintenanceForDate(tradingDate, {
      store: maintenanceJobRunStore,
      stages: createProductionMaintenanceStages(),
    });
    results.push(result);
    log.info('maintenance date complete', { tradingDate, runId: result.runId, status: result.status });
    if (result.status === 'busy') break;
  }
  return results;
}
