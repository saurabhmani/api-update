// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/performance
//
//  Returns the runtime/memory metrics captured during the backtest run
//  plus a derived breakdown (preload %, simulation %, throughput, etc.)
//  so ops dashboards can identify slow runs and memory hotspots without
//  recomputing anything client-side.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadPerformanceMetrics } from '@/lib/backtesting/repository/metricsPersistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}/performance`;
  try {
    await ensureBacktestTables();
    const perf = await loadPerformanceMetrics(params.id);
    if (!perf) {
      return NextResponse.json(
        {
          ok: false,
          error: 'No performance metrics for this run',
          route: ROUTE,
          generatedAt: new Date().toISOString(),
        },
        { status: 404 },
      );
    }

    const total = perf.totalRuntimeMs || 0;
    const pct = (part: number | null | undefined): number | null =>
      part != null && total > 0 ? Math.round((part / total) * 10000) / 100 : null;

    const breakdown = {
      preloadPct: pct(perf.preloadMs),
      simulationPct: pct(perf.simulationMs),
      otherMs: total - (perf.preloadMs ?? 0) - (perf.simulationMs ?? 0),
    };

    return NextResponse.json({
      ok: true,
      runId: params.id,
      performance: perf,
      breakdown,
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
        error: err instanceof Error ? err.message : 'Failed to load performance metrics',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
