// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/calibration — Confidence calibration
//
//  Uses the canonical loader (loadCalibrationSnapshots) so the
//  response always matches the CalibrationBucketResult type
//  (camelCase). No more snake_case mismatch with consumers.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { resolveCalibrationForRun } from '@/lib/backtesting/repository/resolveCalibration';
import { authorizeBacktestRoute } from '@/lib/backtesting/authorization/routeAuthorization';

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const ROUTE = `/api/backtests/${params.id}/calibration`;
  const access = await authorizeBacktestRoute(req, params.id, ROUTE, 'read_calibration');
  if ('response' in access) return access.response;
  try {
    await ensureBacktestTables();
    // Prefer persisted snapshots; recompute + backfill from trades when
    // snapshots were never written (partial_success / older runs).
    const resolved = await resolveCalibrationForRun(params.id);
    const buckets = resolved.buckets;

    // Aggregate metadata for the dashboard
    const overconfident = buckets.filter(b => b.calibrationState === 'overconfident' || b.calibrationState === 'slightly_overconfident');
    const underconfident = buckets.filter(b => b.calibrationState === 'underconfident');
    const wellCalibrated = buckets.filter(b => b.calibrationState === 'well_calibrated');

    return NextResponse.json({
      ok: true,
      runId: params.id,
      total: buckets.length,
      buckets,
      source: resolved.source,
      summary: {
        overconfidentCount: overconfident.length,
        underconfidentCount: underconfident.length,
        wellCalibratedCount: wellCalibrated.length,
        recommendation: buckets.length === 0
          ? resolved.tradeCount === 0
            ? 'No trades persisted for this run — cannot calibrate'
            : 'No calibration data available'
          : overconfident.length > underconfident.length
          ? 'Reduce confidence on overconfident bands'
          : underconfident.length > 0
          ? 'Some bands are underconfident — could be more aggressive'
          : 'Calibration is healthy',
      },
    });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      runId: params.id,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to load calibration',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
