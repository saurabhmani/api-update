// ════════════════════════════════════════════════════════════════
//  Phase 3 — Calibration Snapshot Builder
//
//  Whether the manipulation engine is *useful* is an empirical
//  question. This module captures the answer:
//   • Per suspicion band, what's the win rate / avg PnL of trades
//     that fired in that bucket during a backtest?
//   • Stored as one row per (run_id, band) so trends can be charted
//     over time.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { CalibrationSnapshotRecord, SuspicionBand } from '../types';
import { bucketTradesByScore } from './manipulationAnalytics';

export interface CalibrationInputTrade {
  score: number | null;
  outcome: 'win' | 'loss' | 'breakeven' | string;
  pnlPct?: number;
  isFalseBreakout?: boolean;
}

/**
 * Build calibration snapshots for a backtest run from already-fetched
 * trades. Pure — no DB. Returns one record per band.
 */
export function buildCalibrationSnapshots(
  runId: string | null,
  snapshotDate: string,
  trades: CalibrationInputTrade[],
): CalibrationSnapshotRecord[] {
  const buckets = bucketTradesByScore(trades);
  return buckets.map((b) => {
    const arr = trades.filter((t) => {
      const score = t.score ?? 0;
      // Re-derive bucket band cheaply; bucketTradesByScore already
      // categorised so we can mirror via the bucket sample size.
      return score >= bandFloor(b.band) && score <= bandCeiling(b.band);
    });
    const fb = arr.filter((t) => t.isFalseBreakout).length;
    return {
      runId,
      snapshotDate,
      bucketBand: b.band,
      sampleSize: b.sampleSize,
      winRate: b.winRate,
      avgPnlPct: b.avgPnlPct,
      falseBreakoutRate: arr.length > 0
        ? Number(((fb / arr.length) * 100).toFixed(2))
        : null,
    };
  });
}

export async function persistCalibrationSnapshots(
  records: CalibrationSnapshotRecord[],
): Promise<void> {
  for (const r of records) {
    await db.query(
      `INSERT INTO q365_manipulation_calibration_snapshots
        (run_id, snapshot_date, bucket_band, sample_size, win_rate, avg_pnl_pct, false_breakout_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        r.runId,
        r.snapshotDate,
        r.bucketBand,
        r.sampleSize,
        r.winRate,
        r.avgPnlPct,
        r.falseBreakoutRate,
      ],
    );
  }
}

export async function loadCalibrationSnapshots(
  runId?: string,
  limit = 50,
): Promise<CalibrationSnapshotRecord[]> {
  const safe = Math.max(1, Math.min(limit, 500));
  const where = runId ? 'WHERE run_id = ?' : '';
  const params = runId ? [runId] : [];
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_calibration_snapshots
     ${where}
     ORDER BY created_at DESC
     LIMIT ${safe}`,
    params,
  );
  return (rows ?? []).map((r: any) => ({
    id: r.id,
    runId: r.run_id,
    snapshotDate: typeof r.snapshot_date === 'string'
      ? r.snapshot_date
      : new Date(r.snapshot_date).toISOString().split('T')[0],
    bucketBand: r.bucket_band as SuspicionBand,
    sampleSize: Number(r.sample_size),
    winRate: r.win_rate != null ? Number(r.win_rate) : null,
    avgPnlPct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : null,
    falseBreakoutRate: r.false_breakout_rate != null ? Number(r.false_breakout_rate) : null,
    createdAt: r.created_at,
  }));
}

function bandFloor(band: SuspicionBand): number {
  switch (band) {
    case 'low': return 0;
    case 'watch': return 25;
    case 'elevated': return 50;
    case 'high': return 70;
    case 'severe': return 85;
  }
}
function bandCeiling(band: SuspicionBand): number {
  switch (band) {
    case 'low': return 24;
    case 'watch': return 49;
    case 'elevated': return 69;
    case 'high': return 84;
    case 'severe': return 100;
  }
}
