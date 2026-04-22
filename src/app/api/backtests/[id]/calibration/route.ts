// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/calibration — Confidence calibration
//
//  Uses the canonical loader (loadCalibrationSnapshots) so the
//  response always matches the CalibrationBucketResult type
//  (camelCase). No more snake_case mismatch with consumers.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { loadCalibrationSnapshots } from '@/lib/backtesting/repository/metricsPersistence';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await ensureBacktestTables();
    const buckets = await loadCalibrationSnapshots(params.id);

    // Aggregate metadata for the dashboard
    const overconfident = buckets.filter(b => b.calibrationState === 'overconfident' || b.calibrationState === 'slightly_overconfident');
    const underconfident = buckets.filter(b => b.calibrationState === 'underconfident');
    const wellCalibrated = buckets.filter(b => b.calibrationState === 'well_calibrated');

    return NextResponse.json({
      runId: params.id,
      total: buckets.length,
      buckets,
      summary: {
        overconfidentCount: overconfident.length,
        underconfidentCount: underconfident.length,
        wellCalibratedCount: wellCalibrated.length,
        recommendation: overconfident.length > underconfident.length
          ? 'Reduce confidence on overconfident bands'
          : underconfident.length > 0
          ? 'Some bands are underconfident — could be more aggressive'
          : 'Calibration is healthy',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load calibration', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
