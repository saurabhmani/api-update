// ════════════════════════════════════════════════════════════════
//  Controlled signal scan schedule — env flags + IST cron defaults
// ════════════════════════════════════════════════════════════════

export const SIGNAL_SCHEDULE_TIMEZONE = 'Asia/Kolkata';

/** Default IST crons (minute hour dom month dow). */
export const CONTROLLED_SIGNAL_CRONS = {
  readinessCheck:    '30 8 * * 1-5',   // 08:30 — readiness only
  firstMorningScan:  '20 9 * * 1-5',   // 09:20 — first DB-only full scan
  mainMorningScan:   '45 9 * * 1-5',   // 09:45 — main morning DB-only scan
  middayRescore:     '30 12 * * 1-5',  // 12:30 — active signal rescore
  lateRescore:       '45 14 * * 1-5',   // 14:45 — late-day rescore / confirmation
  eveningUpdate:     '0 16 * * 1-5',   // 16:00 — IndianAPI EOD candles
  eveningScan:       '30 16 * * 1-5',   // 16:30 — final EOD DB-only scan
} as const;

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = (process.env[name] ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function envCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

export function isSignalIntradayRegenEnabled(): boolean {
  return envFlag('SIGNAL_INTRADAY_REGEN_ENABLED', false);
}

export function isSignalsAutoRecoveryEnabled(): boolean {
  return envFlag('SIGNALS_AUTO_RECOVERY_ENABLED', false);
}

/** Allow poll-driven GET /api/signals to fire auto-recovery (off by default). */
export function isSignalsAutoRecoveryAllowedOnRead(): boolean {
  return envFlag('SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ', false);
}

export function isDailyScanScheduleEnabled(): boolean {
  return envFlag('DAILY_SCAN_SCHEDULE_ENABLED', true);
}

export function resolveControlledSignalCrons() {
  return {
    readinessCheck: envCron('READINESS_CHECK_CRON', CONTROLLED_SIGNAL_CRONS.readinessCheck),
    firstMorningScan: envCron(
      'FIRST_MORNING_SCAN_CRON',
      envCron('MORNING_SCAN_CRON', CONTROLLED_SIGNAL_CRONS.firstMorningScan),
    ),
    mainMorningScan: envCron('MAIN_MORNING_SCAN_CRON', CONTROLLED_SIGNAL_CRONS.mainMorningScan),
    middayRescore: envCron('MIDDAY_RESCORE_CRON', CONTROLLED_SIGNAL_CRONS.middayRescore),
    lateRescore: envCron('LATE_RESCORE_CRON', CONTROLLED_SIGNAL_CRONS.lateRescore),
    eveningUpdate: envCron(
      'EVENING_UPDATE_CRON',
      process.env.CANDLE_DAILY_UPDATE_CRON?.trim() || CONTROLLED_SIGNAL_CRONS.eveningUpdate,
    ),
    eveningScan: envCron('EVENING_SCAN_CRON', CONTROLLED_SIGNAL_CRONS.eveningScan),
  };
}
