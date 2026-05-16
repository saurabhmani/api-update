// ════════════════════════════════════════════════════════════════
//  Feed-health retention cron — Step 6.5 of the IndianAPI cutover.
//
//  Deletes q365_data_feed_health rows older than the configured
//  retention window (default 30 days). Runs once a day; safe to
//  invoke any time — the DELETE is bounded by an indexed range scan
//  on `created_at`.
//
//  Why not let MySQL's row-based partitioning handle it: this table
//  doesn't grow large enough to justify partitioning and the project
//  uses InnoDB without auto-partition tooling. A nightly DELETE is
//  the cheapest correct option.
// ════════════════════════════════════════════════════════════════

import cron from 'node-cron';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'feedHealthRetention' });

const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.FEED_HEALTH_RETENTION_DAYS) || 30,
);

/** Run one prune pass. Idempotent — safe to call from a cron tick
 *  AND from a one-shot CLI/admin endpoint. */
export async function pruneFeedHealthOnce(): Promise<{ deleted: number }> {
  try {
    const result = await db.query(
      `DELETE FROM q365_data_feed_health
        WHERE created_at < (NOW() - INTERVAL ? DAY)`,
      [RETENTION_DAYS],
    );
    const deleted = (result as { affectedRows?: number })?.affectedRows ?? 0;
    if (deleted > 0) {
      log.info('feedHealthRetention prune complete', {
        deleted, retention_days: RETENTION_DAYS,
      });
    }
    return { deleted };
  } catch (err) {
    log.warn('feedHealthRetention prune failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: 0 };
  }
}

const GLOBAL_KEY = '__q365_feed_health_retention__';

interface State { task: ReturnType<typeof cron.schedule> | null }

function getState(): State {
  const g = globalThis as unknown as Record<string, State | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { task: null };
  return g[GLOBAL_KEY]!;
}

/** Boot the cron task. HMR-safe: stops any prior instance first.
 *  Schedule: 02:30 IST every day — well outside trading hours. */
export function startFeedHealthRetention(): void {
  const state = getState();
  if (state.task) {
    try { state.task.stop(); } catch { /* already stopped */ }
    state.task = null;
  }
  state.task = cron.schedule(
    '30 2 * * *',
    () => { void pruneFeedHealthOnce(); },
    { timezone: 'Asia/Kolkata' },
  );
  log.info('feedHealthRetention cron installed', {
    schedule: '02:30 IST daily',
    retention_days: RETENTION_DAYS,
  });
}

export function stopFeedHealthRetention(): void {
  const state = getState();
  if (state.task) {
    try { state.task.stop(); } catch { /* already stopped */ }
    state.task = null;
  }
}
