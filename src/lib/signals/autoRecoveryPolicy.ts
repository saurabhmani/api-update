// ════════════════════════════════════════════════════════════════
//  Auto-recovery policy — strongly guarded, off by default
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  isSignalsAutoRecoveryAllowedOnRead,
  isSignalsAutoRecoveryEnabled,
} from '@/lib/signal-engine/schedule/signalSchedulePolicy';
import { getUniverseMinSize } from '@/lib/marketData/nifty500Universe';

export interface AutoRecoveryDecision {
  allowed: boolean;
  reason: string;
}

const SCHEDULED_SOURCES = [
  'cron:morning-scan',
  'cron:first-morning-scan',
  'cron:main-morning-scan',
  'cron:evening-scan',
  'cron:signal-generation',
];

let lastRecoveryDayIst: string | null = null;

function todayIstDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function recentSuccessfulScanExists(withinHours: number): Promise<boolean> {
  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
       FROM q365_signals
      WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND generation_source IN (${SCHEDULED_SOURCES.map(() => '?').join(',')})`,
    [withinHours, ...SCHEDULED_SOURCES],
  );
  return Number((rows[0] as { cnt?: number })?.cnt ?? 0) > 0;
}

async function candleCoverageSufficient(): Promise<{ ok: boolean; pct: number }> {
  const minBars = Number(process.env.AUTO_RECOVERY_MIN_CANDLE_BARS) || 100;
  const minPct  = Number(process.env.AUTO_RECOVERY_MIN_CANDLE_COVERAGE_PCT) || 35;
  const minUni  = getUniverseMinSize();

  const { rows: uniRows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM q365_universe WHERE is_active = 1`,
  );
  const universe = Number((uniRows[0] as { cnt?: number })?.cnt ?? 0);
  if (universe < Math.min(minUni, 100)) {
    return { ok: false, pct: 0 };
  }

  const { rows } = await db.query<{ covered: number }>(
    `SELECT COUNT(*) AS covered FROM (
       SELECT u.symbol
         FROM q365_universe u
         JOIN candles c
           ON c.instrument_key = CONCAT('NSE_EQ|', u.symbol) COLLATE utf8mb4_unicode_ci
          AND c.candle_type = 'eod'
          AND c.interval_unit = '1day'
        WHERE u.is_active = 1
        GROUP BY u.symbol
       HAVING COUNT(*) >= ?
     ) t`,
    [minBars],
  );
  const covered = Number((rows[0] as { covered?: number })?.covered ?? 0);
  const pct = universe > 0 ? Math.round((covered / universe) * 1000) / 10 : 0;
  return { ok: pct >= minPct, pct };
}

/**
 * Decide whether auto-recovery may run.
 * @param opts.bootstrap — explicit ?bootstrap=true (always allowed when enabled)
 * @param opts.onReadPath — GET /api/signals poll (blocked unless ALLOW_ON_READ)
 */
export async function evaluateAutoRecovery(
  triggerReason: string,
  opts: { bootstrap?: boolean; onReadPath?: boolean } = {},
): Promise<AutoRecoveryDecision> {
  if (!isSignalsAutoRecoveryEnabled()) {
    return { allowed: false, reason: 'SIGNALS_AUTO_RECOVERY_ENABLED=false' };
  }

  if (opts.onReadPath && !opts.bootstrap && !isSignalsAutoRecoveryAllowedOnRead()) {
    return {
      allowed: false,
      reason: 'poll-driven auto-recovery disabled (set SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ=true to override)',
    };
  }

  const today = todayIstDate();
  if (lastRecoveryDayIst === today && !opts.bootstrap) {
    return { allowed: false, reason: `auto-recovery already ran today (${today} IST)` };
  }

  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
       FROM q365_signals
      WHERE generation_source = 'auto-recovery:legacy_vendor'
        AND DATE(CONVERT_TZ(generated_at, '+00:00', '+05:30')) = ?`,
    [today],
  );
  if (Number((rows[0] as { cnt?: number })?.cnt ?? 0) > 0 && !opts.bootstrap) {
    return { allowed: false, reason: `auto-recovery row already persisted today (${today} IST)` };
  }

  const recentHours = Number(process.env.AUTO_RECOVERY_RECENT_SCAN_HOURS) || 6;
  if (await recentSuccessfulScanExists(recentHours)) {
    return {
      allowed: false,
      reason: `scheduled scan succeeded within last ${recentHours}h — recovery not needed`,
    };
  }

  const candles = await candleCoverageSufficient();
  if (!candles.ok) {
    return {
      allowed: false,
      reason: `insufficient candle coverage (${candles.pct}% < AUTO_RECOVERY_MIN_CANDLE_COVERAGE_PCT)`,
    };
  }

  return { allowed: true, reason: triggerReason };
}

export function markAutoRecoveryCompleted(): void {
  lastRecoveryDayIst = todayIstDate();
}
