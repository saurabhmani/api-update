// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/analytics?runId=&band=
//
//  Phase 3 — analytics endpoint. Optional runId scopes win-rate and
//  strategy-perf computations to a single backtest run.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  winRateByScoreBucket,
  strategyPerfFiltered,
  loadCalibrationSnapshots,
} from '@/lib/manipulation-engine';
import type { SuspicionBand } from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const runId = req.nextUrl.searchParams.get('runId') ?? undefined;
    const band = (req.nextUrl.searchParams.get('band') as SuspicionBand | null) ?? 'elevated';

    const [winByBucket, calibration] = await Promise.all([
      winRateByScoreBucket(runId),
      loadCalibrationSnapshots(runId, 50),
    ]);

    const stratPerf = runId
      ? await strategyPerfFiltered(runId, band)
      : { included: [], excluded: [] };

    return NextResponse.json({
      runId: runId ?? null,
      filterBand: band,
      winRateByBucket: winByBucket,
      strategyPerf: stratPerf,
      calibration,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
