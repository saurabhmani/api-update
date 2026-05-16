// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/trend?symbol=TCS&days=60
//
//  Phase 2 — historical suspicion score trend.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { ensureManipulationEngineTables, loadSuspicionTrend } from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get('symbol');
    const days = Number(req.nextUrl.searchParams.get('days') ?? 60);
    if (!symbol) {
      return NextResponse.json({ error: 'symbol query param required' }, { status: 400 });
    }
    await ensureManipulationEngineTables();
    const trend = await loadSuspicionTrend(symbol, days);
    return NextResponse.json({ symbol, days, points: trend });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
