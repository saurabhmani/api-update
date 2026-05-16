// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/clusters?startDate=&endDate=&minEvents=3
//
//  Phase 2 — symbols with clusters of manipulation events in a window.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { ensureManipulationEngineTables, loadEventClustersBySymbol } from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    const start = req.nextUrl.searchParams.get('startDate');
    const end = req.nextUrl.searchParams.get('endDate');
    const minEvents = Number(req.nextUrl.searchParams.get('minEvents') ?? 3);
    if (!start || !end) {
      return NextResponse.json(
        { error: 'startDate and endDate query params required' },
        { status: 400 },
      );
    }
    await ensureManipulationEngineTables();
    const clusters = await loadEventClustersBySymbol(start, end, minEvents);
    return NextResponse.json({ start, end, minEvents, count: clusters.length, clusters });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
