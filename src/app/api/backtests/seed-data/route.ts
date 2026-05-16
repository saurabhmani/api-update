// ════════════════════════════════════════════════════════════════
//  POST /api/backtests/seed-data — Fetch & persist historical EOD candles
//  GET  /api/backtests/seed-data — Check data availability
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { seedHistoricalData } from '@/lib/backtesting/data/seedHistoricalData';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET — check how many EOD candles exist per symbol */
export async function GET() {
  const ROUTE = '/api/backtests/seed-data';
  try {
    const symbols = DEFAULT_BACKTEST_CONFIG.universe;
    const counts: { symbol: string; count: number }[] = [];

    for (const symbol of symbols) {
      const { rows } = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM candles
         WHERE instrument_key LIKE ? AND candle_type = 'eod' AND interval_unit = '1day'`,
        [`%${symbol}%`],
      );
      counts.push({ symbol, count: Number(rows[0]?.cnt ?? 0) });
    }

    const total = counts.reduce((s, c) => s + c.count, 0);
    const ready = counts.filter(c => c.count >= 200).length;

    return NextResponse.json({
      ok: true,
      totalSymbols: symbols.length,
      readySymbols: ready,
      totalCandles: total,
      needsSeeding: ready < symbols.length,
      symbols: counts,
    });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to check data',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

/** POST — seed historical data from Yahoo Finance */
export async function POST(req: NextRequest) {
  const ROUTE = '/api/backtests/seed-data';
  try {
    const body = await req.json().catch(() => ({}));
    // Include benchmark symbol along with universe
    const universe = body.symbols ?? DEFAULT_BACKTEST_CONFIG.universe;
    const benchmark = DEFAULT_BACKTEST_CONFIG.benchmarkSymbol;
    const symbols = Array.from(new Set([...universe, benchmark]));
    const range = body.range ?? '2y';

    console.log(`[Seed] Starting historical data seed for ${symbols.length} symbols, range=${range}`);

    const result = await seedHistoricalData(symbols, { range });

    console.log(`[Seed] Complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.failed} failed, ${result.totalCandles} candles`);

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Seed failed',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
