import { getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';
import { findMaintenanceDatesToRun } from './maintenanceDateQueries';
import type { MaintenanceRunRecord, MaintenanceStageName } from './types';

export interface MaintenanceHealthSummary {
  expectedTradingDate:          string;
  lastSuccessfulMaintenanceDate: string | null;
  lastMaintenanceStart:         string | null;
  lastMaintenanceCompletion:    string | null;
  lastFailedStage:              MaintenanceStageName | null;
  lastFailedReason:             string | null;
  catchUpRequired:              boolean;
  catchUpPendingDates:          string[];
  nextExpectedRunIst:           string;
  stageCountByStatus:           Record<string, number>;
}

const DEFAULT_CRON = '30 20 * * 1-5';

function nextMaintenanceRunIst(): string {
  const cron = process.env.DAILY_MAINTENANCE_CRON ?? DEFAULT_CRON;
  const parts = cron.trim().split(/\s+/);
  const minute = parts[0] ?? '30';
  const hour = parts[1] ?? '20';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} IST Mon–Fri`;
}

export async function buildMaintenanceHealthSummary(
  runs: MaintenanceRunRecord[],
  nowMs: number = Date.now(),
): Promise<MaintenanceHealthSummary> {
  const expectedTradingDate = getLatestCompletedTradingDay(nowMs);
  const catchUpPendingDates = await findMaintenanceDatesToRun({ lookbackTradingDays: 7, maxDates: 7 });

  const byDate = new Map<string, MaintenanceRunRecord[]>();
  for (const run of runs) {
    const list = byDate.get(run.tradingDate) ?? [];
    list.push(run);
    byDate.set(run.tradingDate, list);
  }

  let lastSuccessfulMaintenanceDate: string | null = null;
  let lastMaintenanceStart: string | null = null;
  let lastMaintenanceCompletion: string | null = null;
  let lastFailedStage: MaintenanceStageName | null = null;
  let lastFailedReason: string | null = null;

  const sortedDates = [...byDate.keys()].sort();
  for (const date of sortedDates) {
    const stages = byDate.get(date) ?? [];
    const health = stages.find((s) => s.jobName === 'health_snapshot');
    if (health?.status === 'succeeded') {
      lastSuccessfulMaintenanceDate = date;
      lastMaintenanceCompletion = health.completedAt ?? lastMaintenanceCompletion;
    }
    for (const stage of stages) {
      if (stage.status === 'failed') {
        lastFailedStage = stage.jobName;
        lastFailedReason = stage.lastError ?? null;
      }
      if (stage.status === 'running' && !lastMaintenanceStart) {
        lastMaintenanceStart = stage.completedAt ?? null;
      }
    }
  }

  const stageCountByStatus: Record<string, number> = {};
  for (const run of runs) {
    stageCountByStatus[run.status] = (stageCountByStatus[run.status] ?? 0) + 1;
  }

  return {
    expectedTradingDate,
    lastSuccessfulMaintenanceDate,
    lastMaintenanceStart,
    lastMaintenanceCompletion,
    lastFailedStage,
    lastFailedReason,
    catchUpRequired: catchUpPendingDates.length > 0,
    catchUpPendingDates,
    nextExpectedRunIst: nextMaintenanceRunIst(),
    stageCountByStatus,
  };
}
