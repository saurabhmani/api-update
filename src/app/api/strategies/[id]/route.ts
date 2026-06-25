import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadStrategyHubDetail } from '@/lib/strategy-hub';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

/**
 * GET /api/strategies/[id]
 * Full strategy metadata, risk profile, performance, and paper-trading readiness.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const raw = (req.nextUrl.searchParams.get('window') ?? '90D').toUpperCase();
    const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;

    const detail = await loadStrategyHubDetail(id, window);
    if (!detail) {
      return NextResponse.json({ ok: false, error: 'Strategy not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, data: detail, window });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
