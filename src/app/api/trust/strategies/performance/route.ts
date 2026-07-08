import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError, AppError } from '@/lib/errors';
import { loadTrustStrategyPerformance } from '@/lib/trust-layer';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[trust/strategies/performance] auth failed:', err);
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const raw = (req.nextUrl.searchParams.get('window') ?? '90D').toUpperCase();
  const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;

  try {
    const { rows, sourceStatus } = await loadTrustStrategyPerformance(window);
    return NextResponse.json({
      ok: true,
      data: rows,
      window,
      sourceStatus,
      meta: {
        total: rows.length,
        available: rows.filter((r) => r.dataStatus === 'AVAILABLE').length,
        insufficient: rows.filter((r) => r.dataStatus !== 'AVAILABLE').length,
      },
    });
  } catch (err) {
    console.error('[trust/strategies/performance] load failed:', err);
    if (err instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to load strategy performance' },
      { status: 500 },
    );
  }
}
