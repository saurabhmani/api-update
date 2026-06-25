import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadTrustStrategyPerformance } from '@/lib/trust-layer';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const raw = (req.nextUrl.searchParams.get('window') ?? '90D').toUpperCase();
    const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;
    const rows = await loadTrustStrategyPerformance(window);
    return NextResponse.json({ ok: true, data: rows, window });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
