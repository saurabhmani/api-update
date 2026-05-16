// ════════════════════════════════════════════════════════════════
//  POST /api/backtests     — Queue a backtest run (returns immediately)
//  GET  /api/backtests     — List all backtest runs
//
//  POST is asynchronous by default: it INSERTs a backtest_runs row with
//  status='queued' and kicks background processing via the queue worker
//  in src/lib/backtesting/runner/backtestQueue.ts. The HTTP response
//  returns within milliseconds — the UI polls GET /api/backtests/[id]
//  to follow the run through QUEUED → RUNNING → COMPLETED/FAILED.
//
//  Dev/test sync override: BACKTEST_SYNC_MODE=true keeps the old
//  inline-execution path. Production default is queued.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '@/lib/backtesting/runner/runOrchestrator';
import { listBacktestRuns } from '@/lib/backtesting/repository/persistence';
import { validateBacktestConfig } from '@/lib/backtesting/utils/validation';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { queueBacktestRun } from '@/lib/backtesting/runner/backtestQueue';
import type { BacktestRunConfig } from '@/lib/backtesting/types';

export async function POST(req: NextRequest) {
  const ROUTE = '/api/backtests';
  try {
    await ensureBacktestTables();
    const body = await req.json().catch(() => ({}));
    const config: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...(body?.config ?? {}) };

    const validation = validateBacktestConfig(config);
    if (!validation.valid) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid configuration',
          details: validation.errors,
          route: ROUTE,
          generatedAt: new Date().toISOString(),
        },
        { status: 400 },
      );
    }

    // Dev/test escape hatch — keep the legacy inline execution path
    // under an explicit env flag so existing scripts that depend on a
    // single-request completed run can still opt in. Production default
    // is the queued path below.
    if (process.env.BACKTEST_SYNC_MODE === 'true') {
      const result = await runBacktest(config);
      let orchestrated;
      let orchestrationError: string | null = null;
      try {
        orchestrated = await persistFullRun(result);
      } catch (err) {
        orchestrationError = err instanceof Error ? err.message : String(err);
        console.error('[API] Sync-mode orchestration failed:', err);
      }
      return NextResponse.json({
        ok:            true,
        runId:         result.runId,
        status:        result.status,
        mode:          'sync',
        signalCount:   result.signalCount,
        tradeCount:    result.tradeCount,
        durationMs:    result.durationMs,
        message: result.status === 'completed'
          ? `Completed: ${result.tradeCount} trades, ${((result.summary?.winRate ?? 0) * 100).toFixed(0)}% win rate, ${result.summary?.totalReturnPct?.toFixed(2) ?? 0}% return`
          : `${result.status}: ${result.error ?? ''}`,
        persistenceSummary: orchestrated?.persistenceSummary ?? null,
        verdict:            orchestrated?.dexterOutput?.verdict ?? null,
        orchestrationError,
        generatedAt:        new Date().toISOString(),
      });
    }

    // Default path — async queue.
    const queued = await queueBacktestRun(config);
    return NextResponse.json({
      ok:          true,
      runId:       queued.runId,
      status:      queued.status,
      mode:        'queued',
      message:     queued.message,
      generatedAt: new Date().toISOString(),
    }, { status: 202 });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Backtest failed',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  const ROUTE = '/api/backtests';
  try {
    await ensureBacktestTables();
    const runs = await listBacktestRuns();
    return NextResponse.json({ ok: true, runs });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to list backtests',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
