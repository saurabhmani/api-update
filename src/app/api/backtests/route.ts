// ════════════════════════════════════════════════════════════════
//  POST /api/backtests     — Start a backtest (full orchestration)
//  GET  /api/backtests     — List all backtest runs
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '@/lib/backtesting/runner/runOrchestrator';
import { listBacktestRuns } from '@/lib/backtesting/repository/persistence';
import { validateBacktestConfig } from '@/lib/backtesting/utils/validation';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import type { BacktestRunConfig } from '@/lib/backtesting/types';

export async function POST(req: NextRequest) {
  try {
    await ensureBacktestTables();
    const body = await req.json();
    const config: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...body.config };

    const validation = validateBacktestConfig(config);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid configuration', details: validation.errors },
        { status: 400 },
      );
    }

    const result = await runBacktest(config);

    // Single explicit truth-chain persistence — every artifact comes from
    // the in-memory run result, no implicit reconstruction.
    let orchestrated;
    let orchestrationError: string | null = null;
    try {
      orchestrated = await persistFullRun(result);
    } catch (err) {
      orchestrationError = err instanceof Error ? err.message : String(err);
      console.error('[API] Orchestration failed:', err);
    }

    return NextResponse.json({
      runId: result.runId,
      status: result.status,
      signalCount: result.signalCount,
      tradeCount: result.tradeCount,
      durationMs: result.durationMs,
      message: result.status === 'completed'
        ? `Completed: ${result.tradeCount} trades, ${((result.summary?.winRate ?? 0) * 100).toFixed(0)}% win rate, ${result.summary?.totalReturnPct?.toFixed(2) ?? 0}% return`
        : `${result.status}: ${result.error ?? ''}`,
      // Per spec section 6 — full per-table persistence summary
      persistenceSummary: orchestrated?.persistenceSummary ?? null,
      verdict: orchestrated?.dexterOutput?.verdict ?? null,
      orchestrationError,
    });
  } catch (err) {
    console.error('[API] Backtest error:', err);
    return NextResponse.json(
      { error: 'Backtest failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    await ensureBacktestTables();
    const runs = await listBacktestRuns();
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list backtests', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
