// ════════════════════════════════════════════════════════════════
//  POST /api/backtests/[id]/cancel
//
//  Cancels a QUEUED run. Running runs cannot be cancelled because
//  runBacktest does not have a cooperative abort signal yet — the
//  response surfaces that limitation explicitly rather than silently
//  no-oping.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { cancelBacktestRun } from '@/lib/backtesting/runner/backtestQueue';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}/cancel`;
  try {
    const result = await cancelBacktestRun(params.id);
    return NextResponse.json({
      ok:          true,
      runId:       params.id,
      status:      result.status,
      changed:     result.changed,
      reason:      result.reason ?? null,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route:     ROUTE,
      runId:     params.id,
      error:     err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok:          false,
        error:       err instanceof Error ? err.message : 'cancel failed',
        details:     err instanceof Error ? err.message : String(err),
        route:       ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
