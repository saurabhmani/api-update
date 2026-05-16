// ════════════════════════════════════════════════════════════════
//  POST /api/backtests/process-queue
//
//  Manual / scheduled trigger to drain queued backtest_runs rows. The
//  primary entry point for backtests is POST /api/backtests, which
//  inserts a queued row AND fires async processing. This endpoint
//  exists to:
//
//    1. Re-kick processing if the Node process restarted while a run
//       was queued (the in-process void task is lost on restart).
//    2. Let a cron / external scheduler drain the queue every minute
//       without touching POST /api/backtests semantics.
//
//  Concurrency is bounded by `maxConcurrent` (default 1) and guarded
//  by the atomic UPDATE ... WHERE status='queued' claim inside
//  processBacktestRun — see src/lib/backtesting/runner/backtestQueue.ts.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { processQueuedBacktestRuns } from '@/lib/backtesting/runner/backtestQueue';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

const ROUTE = '/api/backtests/process-queue';

export async function POST(req: NextRequest) {
  try {
    await ensureBacktestTables();
    const body = await req.json().catch(() => ({}));
    const maxConcurrent = Math.max(
      1, Math.min(8, Number((body as any)?.maxConcurrent ?? 1) || 1),
    );

    const result = await processQueuedBacktestRuns(maxConcurrent);

    return NextResponse.json({
      ok:          true,
      processed:   result.processed.length,
      runIds:      result.processed,
      running:     result.running,
      queued:      result.remaining,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route:     ROUTE,
      error:     err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok:          false,
        error:       err instanceof Error ? err.message : 'process-queue failed',
        details:     err instanceof Error ? err.message : String(err),
        route:       ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

// GET is useful for "is the queue alive?" probes without firing any work.
export async function GET() {
  try {
    await ensureBacktestTables();
    const result = await processQueuedBacktestRuns(0).catch(() => ({
      processed: [] as string[], remaining: 0, running: 0,
    }));
    return NextResponse.json({
      ok:          true,
      processed:   0,
      runIds:      [] as string[],
      running:     result.running,
      queued:      result.remaining,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok:          false,
        error:       err instanceof Error ? err.message : 'process-queue probe failed',
        route:       ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
