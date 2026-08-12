import { parseIsoDateOnly, compareIsoDateOnly } from '@/lib/dates/isoDateOnly';
import {
  getMarketStatus,
  getLatestCompletedTradingDay,
  toIstCalendarDate,
} from '@/lib/marketData/marketHours';

export type ManipulationLifecyclePhase =
  | 'weekend'
  | 'holiday'
  | 'pre_open'
  | 'market_open'
  | 'post_close_pending_scan'
  | 'post_scan_due';

export interface ExpectedManipulationScanSession {
  expectedSessionDate: string;
  scanDue:             boolean;
  lifecyclePhase:      ManipulationLifecyclePhase;
  reason:              string;
}

export interface ManipulationSessionHealth {
  status:                'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL';
  isStale:               boolean;
  reason:                string;
  expectedSessionDate:   string;
  latestSnapshotSession: string | null;
  scanDue:               boolean;
  lifecyclePhase:        ManipulationLifecyclePhase;
}

const DEFAULT_MAINTENANCE_HOUR   = 20;
const DEFAULT_MAINTENANCE_MINUTE = 30;

function parseMaintenanceCronTime(): { hour: number; minute: number } {
  const cron = process.env.DAILY_MAINTENANCE_CRON ?? '30 20 * * 1-5';
  const parts = cron.trim().split(/\s+/);
  if (parts.length >= 2) {
    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    if (Number.isFinite(minute) && Number.isFinite(hour)) {
      return { hour, minute };
    }
  }
  return { hour: DEFAULT_MAINTENANCE_HOUR, minute: DEFAULT_MAINTENANCE_MINUTE };
}

function istMinutes(nowMs: number): number {
  const ist = new Date(nowMs + 5.5 * 3_600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function istWeekday(nowMs: number): number {
  return new Date(nowMs + 5.5 * 3_600_000).getUTCDay();
}

/** Walk back to the trading session immediately before `fromSessionDate`. */
export function getPreviousCompletedTradingDay(fromSessionDate: string): string {
  const priorMs = new Date(`${fromSessionDate}T03:00:00.000Z`).getTime() - 1;
  return getLatestCompletedTradingDay(priorMs);
}

/**
 * Which manipulation scan session must exist by this point in the IST trading lifecycle?
 * Does NOT compare against MAX(candle ts) — in-progress bars must not stale yesterday's scan.
 */
export function getExpectedManipulationScanSession(
  nowMs: number = Date.now(),
): ExpectedManipulationScanSession {
  const market = getMarketStatus(new Date(nowMs));
  const latestCompleted = getLatestCompletedTradingDay(nowMs);
  const wd = istWeekday(nowMs);
  const maintenance = parseMaintenanceCronTime();
  const maintenanceFromMidnight = maintenance.hour * 60 + maintenance.minute;
  const minutes = istMinutes(nowMs);

  if (wd === 0 || wd === 6) {
    return {
      expectedSessionDate: latestCompleted,
      scanDue:             false,
      lifecyclePhase:      'weekend',
      reason:              'Weekend — last completed session scan remains authoritative.',
    };
  }

  if (market.state === 'holiday') {
    return {
      expectedSessionDate: latestCompleted,
      scanDue:             false,
      lifecyclePhase:      'holiday',
      reason:              'Exchange holiday — no new scan required today.',
    };
  }

  if (market.state === 'pre-open') {
    return {
      expectedSessionDate: latestCompleted,
      scanDue:             false,
      lifecyclePhase:      'pre_open',
      reason:              'Pre-open — prior completed session scan is sufficient.',
    };
  }

  if (market.isOpen) {
    return {
      expectedSessionDate: latestCompleted,
      scanDue:             false,
      lifecyclePhase:      'market_open',
      reason:              'Market open — EOD manipulation for today is not due until post-close maintenance.',
    };
  }

  // Post-close weekday: today's EOD scan becomes required only after maintenance cron.
  if (minutes < maintenanceFromMidnight) {
    const prior = getPreviousCompletedTradingDay(latestCompleted);
    return {
      expectedSessionDate: prior,
      scanDue:             false,
      lifecyclePhase:      'post_close_pending_scan',
      reason:              `Post-close before ${maintenance.hour}:${String(maintenance.minute).padStart(2, '0')} IST maintenance — prior session still expected.`,
    };
  }

  return {
    expectedSessionDate: latestCompleted,
    scanDue:             true,
    lifecyclePhase:      'post_scan_due',
    reason:              `After maintenance window — scan for ${latestCompleted} should have completed.`,
  };
}

export function evaluateManipulationSessionHealth(input: {
  latestSnapshotSessionDate: string | null;
  latestScanAt?:             string | null;
  snapshotCount30d?:         number;
  nowMs?:                    number;
}): ManipulationSessionHealth {
  const nowMs = input.nowMs ?? Date.now();
  const expected = getExpectedManipulationScanSession(nowMs);
  const snapshotSession = parseIsoDateOnly(input.latestSnapshotSessionDate);
  const snapshotCount30d = input.snapshotCount30d ?? 0;

  if (!snapshotSession) {
    const stale = expected.scanDue;
    return {
      status:                stale ? 'STALE' : 'NO_DATA',
      isStale:               stale,
      reason:                stale
        ? `No manipulation snapshots — scan for ${expected.expectedSessionDate} was due.`
        : 'No manipulation snapshots persisted yet.',
      expectedSessionDate:   expected.expectedSessionDate,
      latestSnapshotSession: null,
      scanDue:               expected.scanDue,
      lifecyclePhase:        expected.lifecyclePhase,
    };
  }

  if (compareIsoDateOnly(snapshotSession, expected.expectedSessionDate) >= 0) {
    return {
      status:                snapshotCount30d > 0 ? 'FRESH' : 'PARTIAL',
      isStale:               false,
      reason:                `Snapshot session ${snapshotSession} meets expected ${expected.expectedSessionDate}.`,
      expectedSessionDate:   expected.expectedSessionDate,
      latestSnapshotSession: snapshotSession,
      scanDue:               expected.scanDue,
      lifecyclePhase:        expected.lifecyclePhase,
    };
  }

  if (!expected.scanDue) {
    return {
      status:                'FRESH',
      isStale:               false,
      reason:                `Snapshot ${snapshotSession} is current — scan for ${expected.expectedSessionDate} not yet due (${expected.lifecyclePhase}).`,
      expectedSessionDate:   expected.expectedSessionDate,
      latestSnapshotSession: snapshotSession,
      scanDue:               false,
      lifecyclePhase:        expected.lifecyclePhase,
    };
  }

  return {
    status:                'STALE',
    isStale:               true,
    reason:                `Latest snapshot session ${snapshotSession} is behind expected ${expected.expectedSessionDate}.`,
    expectedSessionDate:   expected.expectedSessionDate,
    latestSnapshotSession: snapshotSession,
    scanDue:               true,
    lifecyclePhase:        expected.lifecyclePhase,
  };
}

/** IST calendar date for a scan timestamp — date-only, no UTC shift. */
export function scanAtToSessionDate(scanAt: string | Date | null | undefined): string | null {
  if (scanAt == null) return null;
  if (typeof scanAt === 'string') {
    const iso = parseIsoDateOnly(scanAt);
    if (iso) return iso;
    const d = new Date(scanAt);
    return Number.isFinite(d.getTime()) ? toIstCalendarDate(d) : null;
  }
  return toIstCalendarDate(scanAt);
}
