import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError, AppError } from '@/lib/errors';
import { loadTrustStrategyPerformance } from '@/lib/trust-layer';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

/**
 * GET /api/performance
 * Global strategy performance leaderboard + optional per-strategy detail.
 * Query: ?window=90D&strategyId=bullish_breakout
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = req.nextUrl;
    const raw = (url.searchParams.get('window') ?? '90D').toUpperCase();
    const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;
    const strategyId = url.searchParams.get('strategyId')?.trim() || null;

    const { rows, sourceStatus } = await loadTrustStrategyPerformance(window);

    if (strategyId) {
      const match = rows.find((r) => r.strategyId === strategyId);
      return NextResponse.json({
        ok: true,
        window,
        global: { strategies: rows, count: rows.length },
        strategy: match ?? null,
        sourceStatus,
      });
    }

    const blendedWinRate = rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.winRate, 0) / rows.length)
      : 0;
    const totalTrades = rows.reduce((s, r) => s + r.totalTrades, 0);

    return NextResponse.json({
      ok: true,
      window,
      global: {
        strategies: rows,
        count: rows.length,
        blendedWinRate,
        totalTrades,
      },
      strategy: null,
      sourceStatus,
    });
  } catch (err) {
    console.error('[api/performance] load failed:', err);
    if (err instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to load performance' },
      { status: 500 },
    );
  }
}
