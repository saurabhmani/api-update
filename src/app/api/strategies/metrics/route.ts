import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadStrategyMetrics } from '@/lib/strategy-hub/services/strategyMetricsService';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

/**
 * GET /api/strategies/metrics?strategyId=&window=90D
 * Strategy Metrics Service — per-strategy or bulk performance metrics.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const raw = (url.searchParams.get('window') ?? '90D').toUpperCase();
    const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;
    const strategyId = url.searchParams.get('strategyId')?.trim();

    if (strategyId) {
      const metrics = await loadStrategyMetrics(strategyId, window);
      return NextResponse.json({ ok: true, strategyId, window, ...metrics });
    }

    const { loadAllStrategyMetrics } = await import('@/lib/strategy-hub/services/strategyMetricsService');
    const all = await loadAllStrategyMetrics(window);
    const strategies = Object.fromEntries(all);

    return NextResponse.json({ ok: true, window, strategies, count: all.size });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
