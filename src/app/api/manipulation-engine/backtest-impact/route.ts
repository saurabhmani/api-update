// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/backtest-impact?runId=...
//
//  Phase 3 — what would the run have looked like with the manipulation
//  filter on vs off? Returns side-by-side counts and per-strategy P&L.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  ensureManipulationEngineTables,
  strategyPerfFiltered,
  winRateByScoreBucket,
} from '@/lib/manipulation-engine';
import type { SuspicionBand } from '@/lib/manipulation-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const runId = req.nextUrl.searchParams.get('runId');
    const band = (req.nextUrl.searchParams.get('band') as SuspicionBand | null) ?? 'elevated';
    if (!runId) {
      return NextResponse.json({ error: 'runId required' }, { status: 400 });
    }

    // Aggregate counts directly from backtest_signals.
    const { rows: countRows } = await db.query<any>(
      `SELECT
         COUNT(*)                              AS total_signals,
         SUM(CASE WHEN excluded_by_manipulation = 1 THEN 1 ELSE 0 END) AS filtered,
         SUM(CASE WHEN manipulation_band = 'severe' THEN 1 ELSE 0 END) AS severe,
         SUM(CASE WHEN manipulation_band = 'high'   THEN 1 ELSE 0 END) AS high,
         SUM(CASE WHEN manipulation_band = 'elevated' THEN 1 ELSE 0 END) AS elevated,
         SUM(CASE WHEN manipulation_band = 'watch'   THEN 1 ELSE 0 END) AS watch,
         SUM(CASE WHEN manipulation_band = 'low' OR manipulation_band IS NULL THEN 1 ELSE 0 END) AS low
       FROM backtest_signals
       WHERE run_id = ?`,
      [runId],
    );
    const counts = countRows[0] ?? {};

    const [stratPerf, winByBucket] = await Promise.all([
      strategyPerfFiltered(runId, band),
      winRateByScoreBucket(runId),
    ]);

    return NextResponse.json({
      runId,
      filterBand: band,
      counts: {
        totalSignals: Number(counts.total_signals ?? 0),
        filteredOut: Number(counts.filtered ?? 0),
        bandDistribution: {
          severe: Number(counts.severe ?? 0),
          high: Number(counts.high ?? 0),
          elevated: Number(counts.elevated ?? 0),
          watch: Number(counts.watch ?? 0),
          low: Number(counts.low ?? 0),
        },
      },
      strategyPerf: stratPerf,
      winRateByBucket: winByBucket,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
