// ════════════════════════════════════════════════════════════════
//  GET /api/debug/signal-maturity-status
//
//  Read-only maturity funnel snapshot: tracker distribution,
//  confirmed snapshots, recent promotions, active q365_signals rows,
//  env knobs, and operator-facing diagnosis hints.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getTrackerStaleResetMin } from '@/lib/signal-engine/repository/maturityTracker';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface TrackerRow {
  stage: string;
  count: number | string;
  avg_cycles: number | string | null;
  max_cycles: number | string | null;
  min_cycles: number | string | null;
  eligible_2plus: number | string | null;
}

interface SnapshotRow {
  status: string;
  count: number | string;
  latest: string | null;
}

const VALIDITY_MIN = 60;
const VALIDITY_MAX = 1440;
const VALIDITY_DEFAULT = 90;

function resolveValidityMinutes(): number {
  const raw = Number(process.env.CONFIRMED_SNAPSHOT_VALIDITY_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return VALIDITY_DEFAULT;
  return Math.max(VALIDITY_MIN, Math.min(VALIDITY_MAX, Math.floor(raw)));
}

export async function GET(): Promise<Response> {
  try {
    const { rows: trackerRows } = await db.query<TrackerRow>(`
      SELECT
        stage,
        COUNT(*) AS count,
        AVG(validation_cycles_passed) AS avg_cycles,
        MAX(validation_cycles_passed) AS max_cycles,
        MIN(validation_cycles_passed) AS min_cycles,
        SUM(CASE WHEN validation_cycles_passed >= 2 THEN 1 ELSE 0 END) AS eligible_2plus
      FROM q365_signal_maturity_tracker
      WHERE stage IN ('candidate', 'developing', 'mature')
      GROUP BY stage
      ORDER BY stage
    `);

    const { rows: snapshotRows } = await db.query<SnapshotRow>(`
      SELECT
        status,
        COUNT(*) AS count,
        MAX(confirmed_at) AS latest
      FROM q365_confirmed_signal_snapshots
      GROUP BY status
    `);

    const { rows: promotionRows } = await db.query(`
      SELECT symbol, direction, maturity_score, validation_cycles_passed,
             confidence_score, final_score, confirmed_at
      FROM q365_confirmed_signal_snapshots
      ORDER BY confirmed_at DESC
      LIMIT 10
    `);

    const { rows: signalRows } = await db.query(`
      SELECT symbol, direction, signal_type, confidence_score, final_score,
             created_at, expires_at
      FROM q365_signals
      WHERE expires_at IS NULL OR expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const staleResetEffective = getTrackerStaleResetMin();
    const validityEffective = resolveValidityMinutes();

    const config = {
      TRACKER_STALE_RESET_MIN: process.env.TRACKER_STALE_RESET_MIN ?? '(not set — default 360)',
      TRACKER_STALE_RESET_MIN_EFFECTIVE: staleResetEffective,
      MATURITY_MIN_CYCLES: process.env.MATURITY_MIN_CYCLES ?? '(not set — default 3)',
      PROMOTE_MIN_CYCLES: process.env.PROMOTE_MIN_CYCLES ?? '(not set — default 2)',
      MATURITY_MATURE_THRESHOLD: process.env.MATURITY_MATURE_THRESHOLD ?? '(not set — default 70)',
      MATURITY_PROMOTE_THRESHOLD: process.env.MATURITY_PROMOTE_THRESHOLD ?? '(not set — default 70)',
      PROMOTE_MIN_MATURITY: process.env.PROMOTE_MIN_MATURITY ?? '(not set — default 70)',
      CONFIRMED_SNAPSHOT_VALIDITY_MINUTES: process.env.CONFIRMED_SNAPSHOT_VALIDITY_MINUTES ?? '(not set — default 90)',
      CONFIRMED_SNAPSHOT_VALIDITY_MINUTES_EFFECTIVE: validityEffective,
      SIGNAL_ELITE_NEVER_EMPTY: process.env.SIGNAL_ELITE_NEVER_EMPTY ?? '(not set)',
    };

    const diagnosis: string[] = [];
    const totalTrackers = trackerRows.reduce((s, r) => s + Number(r.count ?? 0), 0);
    const totalSnapshots = snapshotRows.reduce((s, r) => s + Number(r.count ?? 0), 0);
    const activeSnapshots = snapshotRows.find((r) => r.status === 'ACTIVE');

    if (totalTrackers === 0) {
      diagnosis.push('CRITICAL: No active trackers. Run /api/run-signal-engine to detect signals first.');
    }
    if (totalSnapshots === 0) {
      diagnosis.push('WARNING: No confirmed snapshots exist. Maturity worker has not promoted any trackers yet.');
    }
    if (staleResetEffective < 480) {
      diagnosis.push(
        `WARNING: TRACKER_STALE_RESET_MIN effective=${staleResetEffective}min < 480min morning→evening gap. Trackers may reset between scans.`,
      );
    }
    if (!process.env.MATURITY_MIN_CYCLES) {
      diagnosis.push('INFO: MATURITY_MIN_CYCLES not set — code default is 3 cycles before stage graduation.');
    }
    if (signalRows.length === 0) {
      diagnosis.push('CRITICAL: No active signals in q365_signals. Run /api/run-signal-engine.');
    }

    return NextResponse.json({
      ok: true,
      diagnosis,
      config,
      trackers: trackerRows,
      confirmed_snapshots: {
        by_status: {
          ACTIVE: Number(activeSnapshots?.count ?? 0),
          TARGET_HIT: Number(snapshotRows.find((r) => r.status === 'TARGET_HIT')?.count ?? 0),
          STOP_LOSS_HIT: Number(snapshotRows.find((r) => r.status === 'STOP_LOSS_HIT')?.count ?? 0),
          INVALIDATED: Number(snapshotRows.find((r) => r.status === 'INVALIDATED')?.count ?? 0),
          EXPIRED: Number(snapshotRows.find((r) => r.status === 'EXPIRED')?.count ?? 0),
        },
        active_count: Number(activeSnapshots?.count ?? 0),
        recent_promotions: promotionRows,
      },
      active_signals: {
        count: signalRows.length,
        rows: signalRows,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
