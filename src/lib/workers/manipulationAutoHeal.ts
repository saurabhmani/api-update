// Auto-heal stale manipulation snapshots — boot + scheduled recovery

import { logger } from '@/lib/logger';
import {
  clearManipulationFreshnessCache,
  computeManipulationFreshness,
} from '@/lib/manipulation-engine/manipulationSignalRisk';

const log = logger.child({ component: 'manipulationAutoHeal' });

let healInFlight: Promise<void> | null = null;

function autorecoverEnabled(): boolean {
  return process.env.MANIPULATION_AUTORECOVER !== '0';
}

export async function maybeHealStaleManipulationSnapshots(
  reason = 'stale-snapshot-check',
): Promise<{ triggered: boolean; ok?: boolean; message: string }> {
  if (!autorecoverEnabled()) {
    return { triggered: false, message: 'autorecover disabled' };
  }
  if (healInFlight) {
    return { triggered: false, message: 'heal already in flight' };
  }

  const freshness = await computeManipulationFreshness().catch(() => null);
  if (!freshness) {
    return { triggered: false, message: 'freshness probe failed' };
  }

  const needsHeal =
    freshness.isStale ||
    freshness.status === 'PARTIAL' ||
    freshness.status === 'NO_DATA';

  if (!needsHeal) {
    return { triggered: false, message: 'snapshots fresh' };
  }

  log.warn('stale manipulation snapshots detected — starting recovery scan', {
    reason,
    status: freshness.status,
    latestScanAt: freshness.latestScanAt,
    latestCandleDate: freshness.latestCandleDate,
  });

  healInFlight = (async () => {
    try {
      const { runDailyManipulationScan } = await import(
        '@/lib/manipulation-engine/pipeline/runDailyScan'
      );
      const result = await runDailyManipulationScan({ skipIngestion: false });
      clearManipulationFreshnessCache();
      log.info('manipulation auto-heal complete', {
        ok: result.ok,
        snapshotsPersisted: result.scan.snapshotsPersisted,
        latestEventDate: result.latestEventDate,
        warnings: result.warnings,
      });
    } catch (err) {
      log.error('manipulation auto-heal failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      healInFlight = null;
    }
  })();

  await healInFlight;
  clearManipulationFreshnessCache();
  const after = await computeManipulationFreshness().catch(() => null);
  return {
    triggered: true,
    ok: after?.status === 'FRESH',
    message: after?.reason ?? 'recovery scan finished',
  };
}

/** Schedule a deferred heal check — used at boot to avoid contending with schema warmup. */
export function scheduleManipulationAutoHeal(delayMs = 90_000): void {
  if (!autorecoverEnabled()) return;
  setTimeout(() => {
    void maybeHealStaleManipulationSnapshots('boot-delayed-check');
  }, delayMs);
}
