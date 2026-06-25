import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { handleCompareBacktests } from '@/lib/backtesting/api/canonicalHandlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/backtest/compare?ids=run1,run2
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    return handleCompareBacktests(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
