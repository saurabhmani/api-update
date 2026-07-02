// ════════════════════════════════════════════════════════════════
//  Weekly NSE 1000 auto-rebuild scheduler (IST)
//
//  Default: Sunday 22:00 IST (`0 22 * * 0`)
//  Alternate: Monday 08:00 IST (`0 8 * * 1`) via UNIVERSE_WEEKLY_REBUILD_CRON
// ════════════════════════════════════════════════════════════════

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger';
import { runWeeklyNse1000UniverseRebuild } from './weeklyNse1000UniverseRebuild';

const log = logger.child({ component: 'weeklyUniverseSchedule' });
export const WEEKLY_UNIVERSE_TIMEZONE = 'Asia/Kolkata';

/** Sunday 22:00 IST — after US week close, before Monday open. */
export const WEEKLY_UNIVERSE_REBUILD_CRON_DEFAULT = '0 22 * * 0';

const tasks: ScheduledTask[] = [];
let rebuildInFlight: Promise<void> | null = null;

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = (process.env[name] ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function envCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

export function isWeeklyUniverseRebuildEnabled(): boolean {
  return envFlag('UNIVERSE_WEEKLY_REBUILD_ENABLED', true);
}

export function resolveWeeklyUniverseRebuildCron(): string {
  return envCron('UNIVERSE_WEEKLY_REBUILD_CRON', WEEKLY_UNIVERSE_REBUILD_CRON_DEFAULT);
}

export async function runWeeklyUniverseRebuildJob(): Promise<void> {
  if (rebuildInFlight) {
    log.warn('[UNIVERSE_WEEKLY] previous rebuild still in flight — skipping tick');
    return rebuildInFlight;
  }

  rebuildInFlight = (async () => {
    console.log('[UNIVERSE_WEEKLY] scheduled rebuild started');
    const summary = await runWeeklyNse1000UniverseRebuild({
      triggerSource: 'cron:weekly-universe-rebuild',
      useChurnControl: true,
    });
    console.log('[UNIVERSE_WEEKLY] scheduled rebuild complete', {
      ok: summary.ok,
      active: summary.churn?.selected.length ?? summary.universe?.selected.length ?? 0,
      added: summary.churn?.added,
      removed: summary.churn?.removed,
      snapshot_id: summary.snapshotId,
      blockers: summary.blockers,
    });
    if (!summary.ok) {
      log.warn('[UNIVERSE_WEEKLY] rebuild completed with blockers', {
        blockers: summary.blockers,
      });
    }
  })().finally(() => {
    rebuildInFlight = null;
  });

  return rebuildInFlight;
}

export function startWeeklyUniverseSchedule(): void {
  if (!isWeeklyUniverseRebuildEnabled()) {
    log.info('weekly universe rebuild disabled (UNIVERSE_WEEKLY_REBUILD_ENABLED=false)');
    return;
  }
  if (tasks.length > 0) {
    log.warn('weekly universe schedule already started — ignoring duplicate start');
    return;
  }

  const cronExpr = resolveWeeklyUniverseRebuildCron();
  tasks.push(cron.schedule(cronExpr, () => {
    void runWeeklyUniverseRebuildJob().catch((err) => {
      log.error('[UNIVERSE_WEEKLY] scheduled rebuild failed', { err: String(err) });
    });
  }, { timezone: WEEKLY_UNIVERSE_TIMEZONE }));

  log.info('weekly universe schedule started', {
    timezone: WEEKLY_UNIVERSE_TIMEZONE,
    cron: cronExpr,
    churn: {
      add_max_rank: process.env.UNIVERSE_CHURN_ADD_MAX_RANK ?? 900,
      keep_max_rank: process.env.UNIVERSE_CHURN_KEEP_MAX_RANK ?? 1100,
      remove_min_rank: process.env.UNIVERSE_CHURN_REMOVE_MIN_RANK ?? 1200,
    },
  });
}

export function stopWeeklyUniverseSchedule(): void {
  for (const t of tasks) t.stop();
  tasks.length = 0;
  log.info('weekly universe schedule stopped');
}
