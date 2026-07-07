import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  getSignalEngineRegistry,
  syncAllStrategiesToDatabase,
} from '@/lib/strategy-hub/services/strategyRegistryService';
import { loadStrategyHub } from '@/lib/strategy-hub/services/strategyHubService';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS = new Set(['7D', '30D', '90D', '180D', '1Y', 'ALL']);

/**
 * GET /api/strategies/registry
 * Strategy Hub listing with category filters + registry metadata.
 * Query: ?category=&featured=1&paperReady=1&window=90D
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const raw = (url.searchParams.get('window') ?? '90D').toUpperCase();
    const window = (WINDOWS.has(raw) ? raw : '90D') as PerformanceWindow;
    const category = url.searchParams.get('category');
    const featuredOnly = url.searchParams.get('featured') === '1';
    const paperReadyOnly = url.searchParams.get('paperReady') === '1';
    const timeframe = url.searchParams.get('timeframe');
    const direction = url.searchParams.get('direction');
    const marketType = url.searchParams.get('marketType');
    const status = url.searchParams.get('status');
    const risk = url.searchParams.get('risk');

    const hub = await loadStrategyHub({
      category,
      featuredOnly,
      paperReadyOnly,
      window,
      timeframe,
      direction,
      marketType,
      status,
      risk,
    });

    return NextResponse.json({
      ok: true,
      registryDriven: true,
      engineStrategyCount: Object.keys(getSignalEngineRegistry()).length,
      minimumVisible: 5,
      ...hub,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/strategies/registry?action=sync — sync code registry → DB tables */
export async function POST(req: NextRequest) {
  try {
    await requireSession();
    if (req.nextUrl.searchParams.get('action') !== 'sync') {
      return NextResponse.json({ ok: false, error: 'Use ?action=sync' }, { status: 400 });
    }
    const synced = await syncAllStrategiesToDatabase();
    return NextResponse.json({ ok: true, synced });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
