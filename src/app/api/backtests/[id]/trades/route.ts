// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/trades — Trade list for a backtest run
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestTrades } from '@/lib/backtesting/repository/persistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}/trades`;
  try {
    await ensureBacktestTables();
    const trades = await loadBacktestTrades(params.id);
    return NextResponse.json({ ok: true, runId: params.id, trades, total: trades.length });
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
        error: err instanceof Error ? err.message : 'Failed to load trades',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
