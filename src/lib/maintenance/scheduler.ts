import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { maintenanceJobRunStore } from './jobRunRepository';
import { runMaintenanceForDate, type OrchestrationResult } from './orchestrator';
import { createProductionMaintenanceStages } from './productionStages';
import { findMaintenanceDatesToRun } from './maintenanceDateQueries';

export { findMaintenanceDatesToRun } from './maintenanceDateQueries';

const log = logger.child({ component: 'maintenance-scheduler' });

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
